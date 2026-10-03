import type { Edge, Node } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import type { PlanMark } from '../plans/plansStore';
import { menuItemsFor } from './contextMenuItems';
import { applyPlans, cssString, decorFor, focusMatch, ghostEdges, matchMarks, toneOf, type PortTarget } from './plansMarks';

const canon = (id: string): string => (id.startsWith('port:') ? `device:${id.split(':')[1]}` : id);

const chassisNode = (dev: string, x = 0, y = 0): Node => ({
  id: `chassis:${dev}`,
  type: 'chassis',
  position: { x, y },
  data: { chassis: { id: `device:${dev}` } },
});
const cableEdge = (id: string, a: string, b: string): Edge => ({ id, type: 'cable', source: `chassis:${a}`, target: `chassis:${b}`, data: { cable: { id } } });

const nodes = [chassisNode('fw'), chassisNode('sw1', 0, 100), chassisNode('nas', 300, 100)];
const edges = [cableEdge('cable:1', 'fw', 'sw1'), cableEdge('cable:2', 'sw1', 'nas')];

const mark = (over: Partial<PlanMark>): PlanMark => ({ stepId: 's1', ordinal: 1, kind: 'touch', keys: [], word: 'PLANNED', ...over });
const resolve = (id: string): PortTarget | null => {
  const dev = id.split(':')[1]!;
  return { nodeId: `chassis:${dev}`, handleId: id, box: { x: 1, y: 2, w: 10, h: 8 } };
};

describe('matchMarks', () => {
  it('takes the node holding a device key and the cable with a cable key', () => {
    const hit = matchMarks(nodes, edges, [mark({ keys: ['device:nas'] }), mark({ stepId: 's2', ordinal: 2, kind: 'cut-cable', keys: ['cable:1'] })], canon);
    expect([...hit.nodes.keys()]).toEqual(['chassis:nas']);
    expect([...hit.edges.keys()]).toEqual(['cable:1']);
  });

  it('takes a bundle holding a marked cable', () => {
    const bundle: Edge = { id: 'bundle:x', type: 'bundle', source: 'a', target: 'b', data: { bundle: { members: [{ id: 'cable:7' }, { id: 'cable:8' }] } } };
    const hit = matchMarks([], [bundle], [mark({ keys: ['cable:8'] })], canon);
    expect([...hit.edges.keys()]).toEqual(['bundle:x']);
  });

  it('takes nothing for no marks', () => {
    const hit = matchMarks(nodes, edges, [], canon);
    expect(hit.nodes.size + hit.edges.size).toBe(0);
  });
});

describe('tone and tag', () => {
  it('indigo planning, teal doing, ink recorded, ink for done steps', () => {
    expect(toneOf('planned', 'PLANNED')).toBe('plan');
    expect(toneOf('doing', 'STEP 4')).toBe('do');
    expect(toneOf('doing', '✓ DONE')).toBe('done');
    expect(toneOf('doing', '≠ WENT DIFFERENTLY')).toBe('done');
    expect(toneOf('recorded', '✓ DONE')).toBe('record');
  });

  it('is dashed only for an open plan', () => {
    expect(decorFor('planned', [mark({})]).dashed).toBe(true);
    expect(decorFor('doing', [mark({ word: 'STEP 4' })]).dashed).toBe(false);
    expect(decorFor('recorded', [mark({})]).dashed).toBe(false);
  });

  it('shows the lowest step and counts the rest', () => {
    const d = decorFor('planned', [mark({ ordinal: 3, word: 'STEP 3' }), mark({ ordinal: 1, word: 'STEP 1' }), mark({ ordinal: 2, word: 'STEP 2' })]);
    expect(d.word).toBe('STEP 1 +2');
  });

  it('keeps a word from ending its CSS string', () => {
    expect(cssString('a"b\\c')).toBe('"a b c"');
  });
});

describe('ghostEdges', () => {
  const add = mark({ stepId: 'add', kind: 'add-cable', keys: ['device:fw', 'device:nas'], ends: ['port:fw:1', 'port:nas:2'] });

  it('draws a dashed edge between the two plates, in the edge list only', () => {
    const [g] = ghostEdges('planned', [add], nodes, canon, resolve);
    expect(g).toMatchObject({ id: 'plan-ghost:add', type: 'planGhost', source: 'chassis:fw', sourceHandle: 'port:fw:1', target: 'chassis:nas', targetHandle: 'port:nas:2' });
    expect((g!.data as { planMark: { dashed: boolean } }).planMark.dashed).toBe(true);
    expect(edges.some((e) => e.id === g!.id)).toBe(false);
  });

  it('falls back to the two devices when the ports are not drawn (the Diagram look)', () => {
    const free = [
      { id: 'free:device:fw', type: 'freeBox', position: { x: 0, y: 0 }, data: {} },
      { id: 'free:device:nas', type: 'freeBox', position: { x: 400, y: 0 }, data: {} },
    ] as Node[];
    const [g] = ghostEdges('planned', [add], free, (id) => (id.startsWith('port:') ? `device:${id.split(':')[1]}` : id), () => null);
    expect(g).toMatchObject({ source: 'free:device:fw', sourceHandle: 'r', target: 'free:device:nas', targetHandle: 'l' });
  });

  it('draws nothing for a cable it cannot place, and nothing for other kinds', () => {
    expect(ghostEdges('planned', [add], [], canon, () => null)).toEqual([]);
    expect(ghostEdges('planned', [mark({ keys: ['device:fw'] })], nodes, canon, resolve)).toEqual([]);
  });
});

describe('applyPlans', () => {
  const plans = (over: object) => ({ stage: 'planned' as const, marks: [] as PlanMark[], focus: null, ...over });
  const touch = mark({ keys: ['device:nas'] });

  it('changes nothing with no plan open', () => {
    const out = applyPlans({ nodes, edges, plans: { stage: null, marks: [touch], focus: null }, canon, checksShowing: false });
    expect(out.nodes).toBe(nodes);
    expect(out.edges).toBe(edges);
  });

  it('marks the touched node with the stage tone and word, leaving the rest alone', () => {
    const out = applyPlans({ nodes, edges, plans: plans({ marks: [touch] }), canon, checksShowing: false });
    const nas = out.nodes.find((n) => n.id === 'chassis:nas')!;
    expect(nas.className).toContain('plan-mark--plan');
    expect(nas.className).toContain('plan-mark--dashed');
    expect((nas.style as Record<string, string>)['--plan-word']).toBe('"PLANNED"');
    expect(out.nodes.find((n) => n.id === 'chassis:fw')).toBe(nodes[0]);
    expect(out.edges).toBe(edges);
  });

  it('adds ghost edges to the list and never to the input', () => {
    const add = mark({ kind: 'add-cable', keys: ['device:fw'], ends: ['port:fw:1', 'port:nas:2'] });
    const out = applyPlans({ nodes, edges, plans: plans({ marks: [add] }), canon, resolvePort: resolve, checksShowing: false });
    expect(out.edges).toHaveLength(edges.length + 1);
    expect(edges).toHaveLength(2);
  });

  it('fades everything outside the focus with the Checks class, once', () => {
    const out = applyPlans({ nodes, edges, plans: plans({ marks: [touch], focus: new Set(['device:nas']) }), canon, checksShowing: false });
    expect(out.nodes.find((n) => n.id === 'chassis:fw')!.className).toBe('checks-faded');
    expect((out.nodes.find((n) => n.id === 'chassis:fw')!.data as { checksFaded?: boolean }).checksFaded).toBe(true);
    expect(out.nodes.find((n) => n.id === 'chassis:nas')!.className).not.toContain('checks-faded');
    // Neither cable is in the focus (only the device is), so both fade.
    expect(out.edges.map((e) => e.className)).toEqual(['checks-faded', 'checks-faded']);
  });

  it('does not fade again when a Checks Show is on; marks still draw', () => {
    const out = applyPlans({ nodes, edges, plans: plans({ marks: [touch], focus: new Set(['device:nas']) }), canon, checksShowing: true });
    expect(out.nodes.some((n) => (n.className ?? '').includes('checks-faded'))).toBe(false);
    expect(out.nodes.find((n) => n.id === 'chassis:nas')!.className).toContain('plan-mark');
  });

  it('fades without marks when the focus is set and no stage is open', () => {
    const out = applyPlans({ nodes, edges, plans: { stage: null, marks: [], focus: new Set(['device:fw']) }, canon, checksShowing: false });
    expect(out.nodes.filter((n) => n.className === 'checks-faded').map((n) => n.id)).toEqual(['chassis:sw1', 'chassis:nas']);
  });

  it('keeps a ghost and the plates it joins at full strength when its mark is in focus', () => {
    const add = mark({ kind: 'add-cable', keys: ['device:fw', 'device:nas'], ends: ['port:fw:1', 'port:nas:2'] });
    const out = applyPlans({ nodes, edges, plans: plans({ marks: [add], focus: new Set(['device:nas']) }), canon, resolvePort: resolve, checksShowing: false });
    const ghost = out.edges.find((e) => e.id === 'plan-ghost:s1')!;
    expect(ghost.className ?? '').not.toContain('checks-faded');
    expect(out.nodes.find((n) => n.id === 'chassis:fw')!.className ?? '').not.toContain('checks-faded');
    expect(out.nodes.find((n) => n.id === 'chassis:sw1')!.className).toContain('checks-faded');
  });
});

describe('focusMatch', () => {
  it('names the nodes to fit: those holding a key plus both ends of a kept cable', () => {
    const { nodeIds, edgeIds } = focusMatch(nodes, edges, new Set(['cable:1']), canon);
    expect([...nodeIds].sort()).toEqual(['chassis:fw', 'chassis:sw1']);
    expect([...edgeIds]).toEqual(['cable:1']);
  });
});

describe('Plan a change menu item', () => {
  const base = { onSelect: () => {} };
  it('is offered on a device only when the action is given', () => {
    expect(menuItemsFor({ kind: 'chassis', id: 'device:fw' }, base).map((i) => i.label)).not.toContain('Plan a change');
    let got = '';
    const items = menuItemsFor({ kind: 'chassis', id: 'device:fw' }, { ...base, onPlanChange: (id) => (got = id) });
    items.find((i) => i.label === 'Plan a change')!.onSelect();
    expect(got).toBe('device:fw');
  });

  it('is on a free box too, but not a label or a cable', () => {
    const a = { ...base, onPlanChange: () => {} };
    expect(menuItemsFor({ kind: 'free', id: 'x' }, a).map((i) => i.label)).toContain('Plan a change');
    expect(menuItemsFor({ kind: 'label', id: 'x' }, a).map((i) => i.label)).not.toContain('Plan a change');
    expect(menuItemsFor({ kind: 'cable', id: 'x' }, a).map((i) => i.label)).not.toContain('Plan a change');
  });
});
