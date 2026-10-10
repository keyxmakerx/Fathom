import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TraceHop, TraceResult } from '../../engine/engine';
import { createTracePlayer, hopPhase, revealedResult, stepMs, TRACE_TOTAL_MS, traceKey } from './tracePlayback';
import { createTraceStore } from './traceStore';

const hop = (n: number): TraceHop => ({ n, kind: 'device', title: `h${n}`, detail: [], nodes: [], why: '', source: '', scope: '', policies: [], unplaced: [], unplacedWhy: '' });
const result = (count: number): TraceResult => ({ from: 'a', to: 'b', flow: '', stopped: '', hops: Array.from({ length: count }, (_, i) => hop(i + 1)) });

describe('step length', () => {
  it('is 180ms for a short path, easing down to 120ms, and never runs past the total cap', () => {
    expect(stepMs(3)).toBe(180);
    expect(stepMs(10)).toBe(150);
    expect(stepMs(12)).toBe(125);
    for (const n of [2, 5, 12, 20, 60]) expect(stepMs(n) * (n - 1)).toBeLessThanOrEqual(TRACE_TOTAL_MS);
  });
});

describe('what is showing', () => {
  it('shows the first hops while playing and all of them when settled', () => {
    expect(revealedResult(result(5), 2).hops.map((h) => h.n)).toEqual([1, 2]);
    expect(revealedResult(result(5), null).hops).toHaveLength(5);
  });
  it('names where each row stands', () => {
    expect([0, 1, 2].map((i) => hopPhase(i, 2))).toEqual(['done', 'now', 'later']);
    expect(hopPhase(0, null)).toBeNull();
  });
  it('keys the same trace the same way', () => {
    expect(traceKey(result(3))).toBe(traceKey(result(3)));
    expect(traceKey(result(3))).not.toBe(traceKey(result(4)));
  });
});

describe('the player', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lights hops in order, then settles', () => {
    const store = createTraceStore();
    const player = createTracePlayer(store, () => false);
    player.play(result(4));
    expect(store.get().revealed).toBe(1);
    vi.advanceTimersByTime(stepMs(4));
    expect(store.get().revealed).toBe(2);
    vi.advanceTimersByTime(stepMs(4) * 3);
    expect(store.get().revealed).toBeNull();
    expect(store.get().result).not.toBeNull();
  });

  it('settles at once when skipped', () => {
    const store = createTraceStore();
    const player = createTracePlayer(store, () => false);
    player.play(result(6));
    player.settle();
    expect(store.get().revealed).toBeNull();
    vi.advanceTimersByTime(5000);
    expect(store.get().revealed).toBeNull();
  });

  it('settles at once under reduced motion', () => {
    const store = createTraceStore();
    createTracePlayer(store, () => true).play(result(6));
    expect(store.get().revealed).toBeNull();
    expect(store.get().result?.hops).toHaveLength(6);
  });
});
