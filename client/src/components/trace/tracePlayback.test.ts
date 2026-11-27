import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TraceHop, TraceResult } from '../../engine/engine';
import { createTracePlayer, hopPhase, revealedResult, stepMs, TRACE_FRAME_WAIT_MS, TRACE_TOTAL_MS, traceKey } from './tracePlayback';
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

describe('a framed path (a pressed question)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lights no hop until the canvas says it has moved, then plays', () => {
    const store = createTraceStore();
    const player = createTracePlayer(store, () => false);
    player.play(result(4), 1);
    expect(store.get()).toMatchObject({ revealed: 0, frame: 1 });
    expect(revealedResult(store.get().result!, store.get().revealed ?? null).hops).toHaveLength(0);
    vi.advanceTimersByTime(stepMs(4) * 2);
    expect(store.get().revealed).toBe(0);
    store.set({ ...store.get(), framed: 1 });
    expect(store.get().revealed).toBe(1);
    vi.advanceTimersByTime(stepMs(4));
    expect(store.get().revealed).toBe(2);
    vi.advanceTimersByTime(stepMs(4) * 3);
    expect(store.get()).toMatchObject({ revealed: null, frame: 1, framed: 1 });
  });

  it('does not wait for another frame, or for ever', () => {
    const store = createTraceStore();
    const player = createTracePlayer(store, () => false);
    player.play(result(4), 2);
    store.set({ ...store.get(), framed: 1 });
    expect(store.get().revealed).toBe(0);
    vi.advanceTimersByTime(TRACE_FRAME_WAIT_MS);
    expect(store.get().revealed).toBe(1);
    vi.advanceTimersByTime(stepMs(4));
    expect(store.get().revealed).toBe(2);
    // The canvas arriving late changes nothing.
    store.set({ ...store.get(), framed: 2 });
    expect(store.get().revealed).toBe(2);
  });

  it('settles with every hop when skipped during the wait, and the late wait does not restart it', () => {
    const store = createTraceStore();
    const player = createTracePlayer(store, () => false);
    player.play(result(5), 1);
    player.settle();
    expect(store.get()).toMatchObject({ revealed: null, frame: 1 });
    store.set({ ...store.get(), framed: 1 });
    vi.advanceTimersByTime(TRACE_FRAME_WAIT_MS * 2);
    expect(store.get().revealed).toBeNull();
  });

  it('keeps the frame when the hops are played again, and asks for no new one', () => {
    const store = createTraceStore();
    const player = createTracePlayer(store, () => false);
    player.play(result(3), 1);
    store.set({ ...store.get(), framed: 1 });
    vi.advanceTimersByTime(5000);
    player.play(result(3));
    expect(store.get()).toMatchObject({ revealed: 1, frame: 1, framed: 1 });
  });

  it('carries the frame under reduced motion, with every hop showing at once', () => {
    const store = createTraceStore();
    createTracePlayer(store, () => true).play(result(6), 3);
    expect(store.get()).toMatchObject({ revealed: null, frame: 3 });
    expect(store.get().result?.hops).toHaveLength(6);
  });

  it('picks up an answer that changed during the wait', () => {
    const store = createTraceStore();
    const player = createTracePlayer(store, () => false);
    player.play(result(4), 1);
    const edited = { ...result(4), stopped: 'edited' };
    store.set({ ...store.get(), result: edited });
    store.set({ ...store.get(), framed: 1 });
    expect(store.get().result).toBe(edited);
    expect(store.get().revealed).toBe(1);
  });
});
