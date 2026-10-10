import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POINTER_FADE_MS, POINTER_GAP_MS, POINTER_GONE_MS, PointerThrottle, pointerGapMs, pointerOpacity, trackMoves, type Point } from './pointers';

function rig(accept = true) {
  const sent: Array<Point | null> = [];
  let allow = accept;
  const t = new PointerThrottle({
    send: (p) => {
      if (!allow) return false;
      sent.push(p);
      return true;
    },
    now: () => Date.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  return { t, sent, allow: (v: boolean) => (allow = v) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe('the pointer throttle', () => {
  it('sends the first move at once and holds the rest to eight a second', () => {
    const { t, sent } = rig();
    t.move({ x: 1, y: 1 });
    expect(sent).toEqual([{ x: 1, y: 1 }]);
    for (let i = 2; i < 12; i += 1) {
      vi.advanceTimersByTime(10);
      t.move({ x: i, y: i });
    }
    expect(sent).toHaveLength(1); // 100 ms in: nothing more yet
    vi.advanceTimersByTime(POINTER_GAP_MS);
    expect(sent).toEqual([
      { x: 1, y: 1 },
      { x: 11, y: 11 }, // only the latest of the held moves
    ]);
  });

  it('never sends more than eight in one second of constant movement', () => {
    const { t, sent } = rig();
    for (let ms = 0; ms < 1000; ms += 4) {
      t.move({ x: ms, y: 0 });
      vi.advanceTimersByTime(4);
    }
    vi.advanceTimersByTime(POINTER_GAP_MS);
    expect(sent.length).toBeLessThanOrEqual(9);
    expect(sent.length).toBeGreaterThanOrEqual(8);
  });

  it('does not send a pointer that has not moved', () => {
    const { t, sent } = rig();
    t.move({ x: 5, y: 5 });
    vi.advanceTimersByTime(1000);
    t.move({ x: 5.04, y: 4.96 }); // the same to a tenth
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([{ x: 5, y: 5 }]);
  });

  it('says so at once when the pointer leaves, and only once', () => {
    const { t, sent } = rig();
    t.move({ x: 5, y: 5 });
    t.leave();
    t.leave();
    expect(sent).toEqual([{ x: 5, y: 5 }, null]);
  });

  it('drops a held move when the pointer leaves, and says nothing if it never sent', () => {
    const { t, sent } = rig();
    t.leave();
    expect(sent).toEqual([]);
    t.move({ x: 1, y: 1 });
    vi.advanceTimersByTime(20);
    t.move({ x: 2, y: 2 });
    t.leave();
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([{ x: 1, y: 1 }, null]);
  });

  it('keeps trying while nobody is there to see it, and sends the next move once someone is', () => {
    const { t, sent, allow } = rig(false);
    t.move({ x: 1, y: 1 });
    allow(true);
    vi.advanceTimersByTime(1000);
    t.move({ x: 1, y: 1 });
    expect(sent).toEqual([{ x: 1, y: 1 }]);
  });

  it('sends the same spot again after the stream reopened', () => {
    const { t, sent } = rig();
    t.move({ x: 1, y: 1 });
    vi.advanceTimersByTime(1000);
    t.forget();
    t.move({ x: 1, y: 1 });
    expect(sent).toHaveLength(2);
  });
});

describe('the gap between updates', () => {
  it('is 125 ms for a small team and grows with the crowd', () => {
    expect(pointerGapMs(1)).toBe(125);
    expect(pointerGapMs(4)).toBe(125);
    expect(pointerGapMs(5)).toBe(250);
    expect(pointerGapMs(14)).toBe(250);
    expect(pointerGapMs(15)).toBe(500);
  });
});

describe('pointer tracking and fade', () => {
  const p = (account: string, x: number, y: number) => ({ account, name: account, initials: account.slice(0, 2).toUpperCase(), x, y });

  it('stamps new and moved pointers and keeps the stamp of one that stayed', () => {
    const a = trackMoves(new Map(), [p('sam', 1, 1), p('ana', 2, 2)], 100);
    const b = trackMoves(a, [p('sam', 1, 1), p('ana', 3, 2)], 900);
    expect(b.get('sam')!.movedAt).toBe(100);
    expect(b.get('ana')!.movedAt).toBe(900);
    expect(trackMoves(b, [p('sam', 1, 1)], 1000).has('ana')).toBe(false);
  });

  it('fades over the last second before it is gone', () => {
    expect(pointerOpacity(0, 0)).toBe(1);
    expect(pointerOpacity(0, POINTER_FADE_MS)).toBe(1);
    expect(pointerOpacity(0, POINTER_FADE_MS + 500)).toBeCloseTo(0.5);
    expect(pointerOpacity(0, POINTER_GONE_MS)).toBe(0);
    expect(pointerOpacity(0, POINTER_GONE_MS + 1000)).toBe(0);
  });
});
