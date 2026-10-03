import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { TraceHop, TracePolicy, TraceResult } from '../../engine/engine';
import { TracePanel } from './TracePanel';
import { endLine, hiddenCount, hopNumbers, parseFlow, pathKeys, readAddress, readingAs, VERDICT_WORDS, visiblePolicies } from './traceModel';
import { createTraceStore } from './traceStore';
import type { TraceController } from './useTraceController';

const pol = (over: Partial<TracePolicy> = {}): TracePolicy => ({
  id: 'securitypolicy:01M4067EA712RDAY2P182YNR94',
  ordinal: '1',
  name: 'deny-guest-smb-to-fileservers',
  action: 'deny',
  state: 'matches',
  reason: 'source: any; destination: 10.8.0.5 is in branch-file-servers; application: smb covers TCP 445',
  couldAffect: true,
  ...over,
});

const hop = (over: Partial<TraceHop> = {}): TraceHop => ({
  n: 1,
  kind: 'device',
  title: 'fw-01-headquarters',
  detail: ['in on ge-0/0/0.0', 'static route 10.8.0.0/16 via 203.0.113.2', 'out on ge-0/0/1.0'],
  nodes: ['device:01M4067EA712RDAY2P182YNR94', 'logicalunit:01M406GFHVWRHS1SN1RRGGE2E6'],
  why: 'The longest matching prefix wins.',
  source: 'read from a pasted config',
  scope: 'users to servers',
  policies: [],
  unplaced: [],
  unplacedWhy: '',
  ...over,
});

const result = (): TraceResult => ({
  from: 'device:01M4067EA712RDAY2P182YNR94',
  to: '10.8.0.5',
  flow: 'TCP 445',
  stopped: '',
  hops: [
    hop({ n: 1, kind: 'start', title: 'laptop-12', detail: ['from 10.1.0.10'], scope: '', nodes: ['device:L'] }),
    hop({
      n: 2,
      policies: [
        pol({ id: 'p1', ordinal: '1', name: 'allow-dns', action: 'permit', state: "doesn't match", couldAffect: false, reason: 'application: none of its applications covers TCP 445' }),
        pol({ id: 'p2' }),
        pol({ id: 'p3', ordinal: '3', name: 'allow-file-users', action: 'permit', state: "can't tell", reason: 'application: application not read' }),
      ],
      unplaced: [pol({ id: 'p4', ordinal: '1', name: 'lan-rule', action: 'permit', state: "can't tell", reason: "the rule's interface and direction were not read" })],
      unplacedWhy: 'could not establish which interface and direction these rules apply to',
    }),
    hop({ n: 3, kind: 'cable', title: 'cable', detail: ['fw-01 ge-0/0/1 to sw-01 ge-0/0/2'], scope: '', nodes: ['device:F', 'cable:C1', 'device:S'] }),
    hop({ n: 4, kind: 'end', title: 'nas-01', detail: ['holds 10.8.0.5'], scope: '', nodes: ['device:N'] }),
  ],
});

const controller = (over: Partial<TraceController> = {}): TraceController => ({
  open: true,
  store: createTraceStore(),
  from: { deviceId: 'device:L', label: 'laptop-12' },
  query: 'nas-01',
  target: { deviceId: 'device:N', label: 'nas-01' },
  flowText: 'TCP 445',
  flowBad: false,
  suggestions: [],
  result: result(),
  error: '',
  openFrom: () => {},
  close: () => {},
  setQuery: () => {},
  pick: () => {},
  setFlowText: () => {},
  ...over,
});

describe('the flow box', () => {
  it('reads TCP and UDP with a port, and nothing as no flow', () => {
    expect(parseFlow('TCP 445')).toEqual({ protocol: 6, port: 445 });
    expect(parseFlow(' udp/53 ')).toEqual({ protocol: 17, port: 53 });
    expect(parseFlow('')).toBe('none');
    expect(parseFlow('smb')).toBeNull();
    expect(parseFlow('TCP 70000')).toBeNull();
    expect(parseFlow('TCP 0')).toBeNull();
  });
});

describe('the far-end box', () => {
  it('reads an address, and says how it is reading what was typed', () => {
    expect(readAddress('10.8.0.5')).toBe('10.8.0.5');
    expect(readAddress('300.1.1.1')).toBeNull();
    expect(readAddress('2001:db8::5')).toBe('2001:db8::5');
    expect(readAddress('nas-01')).toBeNull();
    expect(readingAs('10.8.0.5', null)).toBe('Reading as an address: 10.8.0.5');
    expect(readingAs('nas', 'nas-01')).toBe('Reading as a device: nas-01');
    expect(readingAs('', null)).toBe('');
    expect(readingAs('nas-0', null)).toContain('Not an address yet');
  });
});

describe('the rows a hop shows', () => {
  it('hides what cannot affect the flow, and counts it', () => {
    const h = result().hops[1]!;
    expect(visiblePolicies(h.policies, false)).toHaveLength(3);
    expect(visiblePolicies(h.policies, true).map((p) => p.name)).toEqual(['deny-guest-smb-to-fileservers', 'allow-file-users']);
    expect(hiddenCount(h, true)).toBe(1);
    expect(hiddenCount(h, false)).toBe(0);
  });

  it('numbers the canvas by hop, one key per device and cable', () => {
    const canon = (id: string) => (id.startsWith('logicalunit') ? 'device:X' : id);
    const m = hopNumbers(result(), canon);
    expect(m.get('device:L')).toEqual([1]);
    expect(m.get('cable:C1')).toEqual([3]);
    expect(pathKeys(result(), canon).has('device:N')).toBe(true);
  });

  it('says where the path ended', () => {
    expect(endLine(result())).toMatch(/^The walk ends at /);
    expect(endLine({ ...result(), stopped: 'no cable is recorded on ge-0/0/1 of rtr-1' })).toBe('Could not establish: no cable is recorded on ge-0/0/1 of rtr-1');
  });
});

describe('the panel', () => {
  const html = (c: TraceController) => renderToStaticMarkup(createElement(TracePanel, { controller: c }));

  it('shows from to, the flow, the hops in order and every policy with its match state', () => {
    const out = html(controller());
    expect(out).toContain('laptop-12 → nas-01');
    expect(out.indexOf('allow-dns')).toBeLessThan(out.indexOf('allow-file-users'));
    expect(out).toContain('data-state="matches"');
    expect(out).toContain("could affect: can&#x27;t tell");
    expect(out).toContain('users to servers reads, in order:');
    expect(out).toContain('Not placed: could not establish which interface and direction');
    expect(out).toMatch(/The walk ends at /);
    expect(out).toContain('Why?');
  });

  it('puts the heavier rule on rows that could affect the flow, and only those', () => {
    const out = html(controller());
    expect((out.match(/trace-policy--affect/g) ?? []).length).toBe(3);
    expect((out.match(/data-testid="trace-policy"/g) ?? []).length).toBe(4);
  });

  it('draws a stop as a stop, not a number', () => {
    const r = { ...result(), stopped: 'x', hops: [...result().hops, hop({ n: 5, kind: 'stop', title: 'could not establish', detail: ['no cable'], scope: '', nodes: [] })] };
    const out = html(controller({ result: r }));
    expect(out).toContain('could not establish');
    expect(out).not.toContain('<span class="trace-hop__n">5</span>');
  });

  it('is nothing until a trace is opened', () => {
    expect(html(controller({ from: null, open: false }))).toBe('');
  });

  it('never says a verdict word anywhere in what it shows', () => {
    const everything = [html(controller()), html(controller({ query: '10.8.0.5', target: null })), html(controller({ flowText: 'smb', flowBad: true })), JSON.stringify(result())]
      .join(' ')
      .toLowerCase();
    for (const w of VERDICT_WORDS) expect(everything).not.toContain(w);
  });
});

describe('the look', () => {
  it('is ink only: no colour literal in the stylesheet', () => {
    const css = readFileSync(fileURLToPath(new URL('./trace.css', import.meta.url)), 'utf8');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch)\(/);
    expect(css).toContain('var(--ink)');
  });
});
