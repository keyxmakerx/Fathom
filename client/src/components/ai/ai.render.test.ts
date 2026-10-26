import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AiIdea, AiKeyView } from '../../api/ai';
import { AiIdeasPanel, aiIdeasTab } from './AiIdeas';
import { keyAppName, stateWords } from './AiPanel';
import { ago, Info, until } from './parts';

const idea = (over: Partial<AiIdea> = {}): AiIdea => ({
  id: 'I1',
  key: 'K1',
  owner: 'A1',
  ownerName: 'Key Maker',
  title: 'Give core-sw-02 its own uplink',
  why: 'One link is a single point of failure.',
  steps: [{ action: 'connect', target: 'D1', text: 'Connect core-sw-02 to edge-fw-01' }],
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
      }),
    );
    expect(out).toContain('Give core-sw-02 its own uplink');
    expect(out).toContain('Key Maker’s connection');
    expect(out).toContain('Show core-sw-02');
    expect(out).toContain('>Accept<');
    expect(out).toContain('>Dismiss<');
  });

  it('gives a reader no buttons, and says who decides', () => {
    const out = renderToStaticMarkup(
      createElement(AiIdeasPanel, { organisationId: 'O', designId: 'D', state: state([idea()]), nameOf: () => null, canDraw: false }),
    );
    expect(out).not.toContain('>Accept<');
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
    label: 'Claude',
    scopes: [],
    sees: ['layout'],
    mayRecommend: true,
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
