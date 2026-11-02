import { describe, expect, it } from 'vitest';

import type { TraceHop, TraceResult } from '../../engine/engine';
import { diagramTrace, numberText } from './diagramTrace';

const hop = (n: number, kind: TraceHop['kind'], nodes: string[]): TraceHop => ({
  n,
  kind,
  title: '',
  detail: [],
  nodes,
  why: '',
  source: '',
  scope: '',
  policies: [],
  unplaced: [],
  unplacedWhy: '',
});

// The engine names nodes by display id; the drawing by chassis and cable id. Canon joins them.
const canon = (id: string) => id.replace(/^device:/, 'ch-').replace(/^cable:/, '');

const walk = (stopped = ''): TraceResult => ({
  from: 'device:A',
  to: '10.0.0.9',
  flow: '',
  stopped,
  hops: [
    hop(1, 'start', ['device:A']),
    hop(2, 'cable', ['device:A', 'cable:c1', 'device:B']),
    hop(3, 'device', ['device:B', 'logicalunit:u1']),
    hop(4, 'cable', ['device:B', 'cable:c2', 'device:C']),
    hop(5, 'end', ['device:C']),
  ],
});

describe('a trace on the Diagram look', () => {
  it('numbers each box and line in walk order and lights only what the walk touches', () => {
    const t = diagramTrace(walk(), canon, ['ch-A', 'ch-B', 'ch-C', 'ch-D'], new Set(['c1', 'c2', 'c3']));
    expect([...t.boxes].sort()).toEqual(['ch-A', 'ch-B', 'ch-C']);
    expect([...t.cables].sort()).toEqual(['c1', 'c2']);
    expect(t.boxNumbers.get('ch-A')).toEqual([1]);
    expect(t.boxNumbers.get('ch-B')).toEqual([3]);
    expect(t.boxNumbers.get('ch-C')).toEqual([5]);
    expect(t.cableNumbers.get('c1')).toEqual([2]);
    expect(t.cableNumbers.get('c2')).toEqual([4]);
    expect(t.stop).toBeNull();
  });

  it('puts a walk that stopped short beside the last box it reached, in the engine words', () => {
    const r = walk('no route to 10.0.0.9 on B');
    r.hops = [...r.hops.slice(0, 3), hop(4, 'stop', [])];
    const t = diagramTrace(r, canon, ['ch-A', 'ch-B', 'ch-C'], new Set(['c1', 'c2']));
    expect(t.stop).toEqual({ boxId: 'ch-B', text: 'no route to 10.0.0.9 on B' });
    expect(t.boxes.has('ch-C')).toBe(false);
  });

  it('writes a box the walk passes twice as both numbers', () => {
    expect(numberText([2, 5])).toBe('2·5');
  });
});
