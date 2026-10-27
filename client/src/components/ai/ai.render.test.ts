import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { helperAppConfig, helperPairCommand, plainWords, type AiIdea, type AiKeyView, type AiOverview } from '../../api/ai';
import { AiIdeasPanel, aiIdeasTab } from './AiIdeas';
import { keyAppName, rulesInWords, stateWords } from './AiPanel';
import { HowToConnect, whyCannotConnect } from './HowToConnect';
import { ago, Info, until } from './parts';

const idea = (over: Partial<AiIdea> = {}): AiIdea => ({
  id: 'I1',
  key: 'K1',
  owner: 'A1',
  ownerName: 'Key Maker',
  title: 'Give core-sw-02 its own uplink',
  why: 'One link is a single point of failure.',
  steps: [{ action: 'connect', target: 'D1', text: 'Connect core-sw-02 to edge-fw-01' }],
  changes: null,
  createdAt: 0,
  state: 'open',
  decidedBy: null,
  decidedAt: null,
  version: 1,
  ...over,
});

const state = (ideas: AiIdea[]) => ({
  ideas,
  open: ideas.filter((i) => i.state === 'open'),
  targets: new Set(['D1']),
  reload: () => undefined,
});

describe('AI ideas on a design', () => {
  it('shows each idea with who sent it, its steps, and Accept and Dismiss for someone who can draw', () => {
    const out = renderToStaticMarkup(
      createElement(AiIdeasPanel, {
        organisationId: 'O',
        designId: 'D',
        state: state([idea()]),
        nameOf: (id: string) => (id === 'D1' ? 'core-sw-02' : null),
        onShow: () => undefined,
        canDraw: true,
        onPlan: () => undefined,
      }),
    );
    expect(out).toContain('Give core-sw-02 its own uplink');
    expect(out).toContain('>Make it a plan<');
    expect(out).toContain('Key Maker’s connection');
    expect(out).toContain('Show core-sw-02');
    expect(out).toContain('>Mark done<');
    expect(out).toContain('accepting changes nothing');
    expect(out).toContain('>Dismiss<');
  });

  it('says Accept and apply, and how much it makes, when the idea carries the change', () => {
    const out = renderToStaticMarkup(
      createElement(AiIdeasPanel, { organisationId: 'O', designId: 'D', state: state([idea({ changes: 3 })]), nameOf: () => null, canDraw: true }),
    );
    expect(out).toContain('>Accept and apply<');
    expect(out).toContain('makes 3 changes in this design, as your edit');
    expect(out).not.toContain('>Mark done<');
  });

  it('gives a reader no buttons, and says who decides', () => {
    const out = renderToStaticMarkup(
      createElement(AiIdeasPanel, { organisationId: 'O', designId: 'D', state: state([idea()]), nameOf: () => null, canDraw: false }),
    );
    expect(out).not.toContain('>Mark done<');
    expect(out).not.toContain('Make it a plan<');
    expect(out).toContain('Someone who can draw here');
  });

  it('is a side tab only while there is something to decide or it is open', () => {
    expect(aiIdeasTab(state([]), false, () => undefined, null)).toBeNull();
    expect(aiIdeasTab(state([idea()]), false, () => undefined, null)).toMatchObject({ id: 'ai-ideas', count: 1 });
    expect(aiIdeasTab(state([]), true, () => undefined, null)).toMatchObject({ id: 'ai-ideas', count: 0 });
  });
});

describe('the words the AI screens use', () => {
  const key = (over: Partial<AiKeyView>): AiKeyView => ({
    id: 'K',
    kind: 'connector',
    app: 'claude',
    owner: 'A',
    ownerName: 'Key Maker',
    ownerEmail: 'key@example.org',
    aiAccount: null,
    label: 'Claude',
    scopes: [],
    sees: ['layout'],
    mayRecommend: true,
    mayChange: false,
    createdAt: 0,
    expiresAt: 0,
    state: 'on',
    stoppedAt: null,
    stoppedBy: null,
    stoppedByKind: null,
    stoppedReason: null,
    lastUsedAt: null,
    lastUsedFrom: null,
    requestsToday: 0,
    mine: true,
    version: 1,
    ...over,
  });

  it('names the app and who turned a connection off', () => {
    expect(keyAppName(key({}))).toBe('Claude');
    expect(keyAppName(key({ app: 'helper', kind: 'helper' }))).toBe('Fathom AI helper');
    expect(stateWords(key({ state: 'disabled', stoppedByKind: 'operator' }))).toBe('Off by admin');
    expect(stateWords(key({ state: 'disabled', stoppedByKind: 'steward' }))).toBe('Off by a Steward');
  });

  it('counts time the way a person reads it', () => {
    expect(ago(null)).toBe('never');
    expect(ago(1000, 1030)).toBe('just now');
    expect(until(86400 * 10, 0)).toBe('in 10 days');
    expect(until(0, 10)).toBe('ended');
  });

  it('draws the "i" closed, as a button that says what it explains', () => {
    const out = renderToStaticMarkup(createElement(Info, { label: 'What a connection is', children: 'Hidden until pressed' }));
    expect(out).toContain('aria-label="What a connection is"');
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain('Hidden until pressed');
  });
});

describe('Connect an AI app', () => {
  const overview = (over: Partial<AiOverview> = {}): AiOverview => ({
    server: { allowed: true, reason: null },
    policy: {
      allowed: true,
      makers: [],
      ceiling: ['layout', 'addresses'],
      apps: ['claude'],
      maxDays: 90,
      secondPersonScopes: [],
      mayChange: false,
      changedBy: null,
      changedAt: null,
      version: 1,
    },
    steward: false,
    canMake: true,
    keys: [],
    deployment: 'dep',
    connector: null,
    ...over,
  });
  const draw = (o: AiOverview) =>
    renderToStaticMarkup(
      createElement(HowToConnect, {
        organisationId: 'O',
        organisationName: 'Acme',
        overview: o,
        folders: [],
        origin: 'https://fathom.example.org',
        onMade: () => undefined,
      }),
    );

  it('offers the helper key when apps cannot sign in, with the line to run and the form', () => {
    const out = draw(overview());
    expect(out).toContain('node fathom-ai.mjs pair https://fathom.example.org');
    expect(out).toContain('not a personal one');
    expect(out).toContain('Which AI account the app is signed in to');
    expect(out).toContain('href="/fathom-ai.mjs"');
    expect(out).toContain('>Make key<');
    expect(out).toContain('claude mcp add fathom -- node /path/to/fathom-ai.mjs');
  });

  it('opens on the sign-in address when the connector is on', () => {
    const out = draw(overview({ connector: 'https://fathom.example.org/mcp' }));
    expect(out).toContain('data-testid="ai-connector-url">https://fathom.example.org/mcp<');
    expect(out).not.toContain('>Make key<');
  });

  it('shows no form, and says who can change it, when the person may not connect', () => {
    const out = draw(overview({ canMake: false }));
    expect(out).not.toContain('>Make key<');
    expect(out).toContain('has to name you');
    expect(whyCannotConnect(overview({ server: { allowed: false, reason: null } }), 'Acme')).toContain('whole server');
    expect(whyCannotConnect(overview(), 'Acme')).toBeNull();
  });

  it('offers "May change designs" only when the organisation allows it, unticked', () => {
    expect(draw(overview())).not.toContain('May change designs');
    const on = overview();
    on.policy.mayChange = true;
    const out = draw(on);
    expect(out).toContain('May change designs');
    expect(out).not.toMatch(/data-testid="ai-helper-may-change"[^>]*checked/);
  });

  it('says in plain words that a connection may change designs, and the risk', () => {
    const words = plainWords({ scopes: [], sees: ['layout'], mayRecommend: true, mayChange: true }, () => 'x');
    expect(words.join(' ')).toContain('Can change designs you can draw in');
    expect(words.join(' ')).toContain('Text inside a design can steer an AI');
    expect(plainWords({ scopes: [], sees: ['layout'], mayRecommend: true }, () => 'x').join(' ')).not.toContain('change designs');
  });

  it('writes the app settings with the path the person gives', () => {
    expect(helperPairCommand('https://f.example')).toBe('node fathom-ai.mjs pair https://f.example');
    const c = helperAppConfig('/home/me/fathom-ai.mjs');
    expect(JSON.parse(c.json)).toEqual({ mcpServers: { fathom: { command: 'node', args: ['/home/me/fathom-ai.mjs'] } } });
  });
});

describe('the line at the top of the AI page', () => {
  const policy = {
    allowed: true,
    makers: ['A1', 'A2'],
    ceiling: ['layout', 'addresses'] as const,
    maxDays: 90,
    secondPersonScopes: [],
    apps: ['claude', 'claude-code'] as const,
    mayChange: false,
    changedBy: null,
    changedAt: null,
    version: 1,
  };

  it('says in one sentence what the rules allow', () => {
    expect(rulesInWords({ ...policy, ceiling: [...policy.ceiling], apps: [...policy.apps] }, true)).toBe(
      'AI is on. Claude and Claude Code may connect, for 2 people, seeing at most the layout and addresses, for up to 90 days.',
    );
  });

  it('sends a Steward to AI rules when AI is off, and tells anyone else who can turn it on', () => {
    const off = { ...policy, allowed: false, ceiling: [...policy.ceiling], apps: [...policy.apps] };
    expect(rulesInWords(off, true)).toMatch(/turn it on in AI rules/);
    expect(rulesInWords(off, false)).toBe('AI is off here. A Steward can turn it on.');
  });
});
