import { describe, expect, it } from 'vitest';

import {
  COALESCE_MS,
  EMPTY_TRAIL,
  MAX_STEPS,
  addStep,
  back,
  canGoBack,
  canGoForward,
  chipWindow,
  forward,
  jumpTo,
  spotKey,
  stepLabel,
  visit,
  withCamera,
  type Spot,
  type Trail,
} from './jumpBack';

const spot = (over: Partial<Spot> = {}): Spot => ({ look: 'rack', selection: null, jotId: null, stop: 'rack', ...over });
const sel = (id: string) => ({ kind: 'rack', id });

/** Steps made well apart, so nothing coalesces. */
function walkTo(spots: Spot[], labels: string[] = spots.map((_, i) => `S${i}`)): Trail {
  let t = EMPTY_TRAIL;
  spots.forEach((s, i) => {
    t = visit(t, s, labels[i]!, null, i * 10_000);
  });
  return t;
}

describe('push', () => {
  it('the first visit is the first step', () => {
    const t = visit(EMPTY_TRAIL, spot(), 'HQ', null, 0);
    expect(t.steps).toHaveLength(1);
    expect(t.index).toBe(0);
    expect(canGoBack(t)).toBe(false);
    expect(canGoForward(t)).toBe(false);
  });

  it('a new place is a new step after the current one', () => {
    const t = walkTo([spot(), spot({ selection: sel('r1') }), spot({ selection: sel('r1'), stop: 'faceplate' })]);
    expect(t.steps.map((s) => s.label)).toEqual(['S0', 'S1', 'S2']);
    expect(t.index).toBe(2);
  });

  it('the same place again adds nothing, but a new label is kept', () => {
    const t = walkTo([spot()]);
    expect(visit(t, spot(), 'S0', null, 99_999)).toBe(t);
    const renamed = visit(t, spot(), 'RENAMED', null, 99_999);
    expect(renamed.steps).toHaveLength(1);
    expect(renamed.steps[0]!.label).toBe('RENAMED');
  });

  it('tells a different thing, device, look and level apart', () => {
    const keys = new Set([spot(), spot({ selection: sel('a') }), spot({ selection: { kind: 'cable', id: 'a' } }), spot({ jotId: 'a' }), spot({ look: 'diagram' }), spot({ stop: 'faceplate' }), spot({ stop: 'inside' })].map(spotKey));
    expect(keys.size).toBe(7);
  });

  it('counts the whole room and one rack as the same level', () => {
    const t = walkTo([spot({ stop: 'closet' })]);
    expect(visit(t, spot({ stop: 'rack' }), 'S0', null, 99_999)).toBe(t);
  });

  it('drops the oldest past the limit and keeps the current step current', () => {
    let t = EMPTY_TRAIL;
    for (let i = 0; i < MAX_STEPS + 5; i += 1) t = visit(t, spot({ selection: sel(`r${i}`) }), `S${i}`, null, i * 10_000);
    expect(t.steps).toHaveLength(MAX_STEPS);
    expect(t.index).toBe(MAX_STEPS - 1);
    expect(t.steps[t.index]!.label).toBe(`S${MAX_STEPS + 4}`);
  });
});

describe('coalesce', () => {
  it('a quick run of zoom stops is one step', () => {
    let t = visit(EMPTY_TRAIL, spot(), 'HQ', null, 0);
    t = visit(t, spot({ selection: sel('r1') }), 'R1', null, 10_000);
    t = visit(t, spot({ selection: sel('r1'), stop: 'faceplate' }), 'R1 FACEPLATE', null, 10_100);
    t = visit(t, spot({ selection: sel('r1'), stop: 'inside' }), 'R1 INSIDE', null, 10_200);
    expect(t.steps.map((s) => s.label)).toEqual(['HQ', 'R1 INSIDE']);
  });

  it('a zoom well after the last step is a step of its own', () => {
    let t = visit(EMPTY_TRAIL, spot({ selection: sel('r1') }), 'R1', null, 0);
    t = visit(t, spot({ selection: sel('r1'), stop: 'faceplate' }), 'R1 FACEPLATE', null, COALESCE_MS + 1);
    expect(t.steps).toHaveLength(2);
  });

  it('never folds into the very first step', () => {
    let t = visit(EMPTY_TRAIL, spot(), 'HQ', null, 0);
    t = visit(t, spot({ stop: 'faceplate' }), 'HQ FACEPLATE', null, 100);
    expect(t.steps).toHaveLength(2);
  });

  it('choosing a different thing is always a step, however quick', () => {
    let t = visit(EMPTY_TRAIL, spot(), 'HQ', null, 0);
    t = visit(t, spot({ selection: sel('a') }), 'A', null, 10);
    t = visit(t, spot({ selection: sel('b') }), 'B', null, 20);
    expect(t.steps.map((s) => s.label)).toEqual(['HQ', 'A', 'B']);
  });

  it('while the camera glides back to a step, a stop on the way is absorbed', () => {
    let t = walkTo([spot(), spot({ selection: sel('r1'), stop: 'faceplate' })]);
    const moved = back(t)!;
    t = moved.trail;
    t = visit(t, spot({ stop: 'faceplate' }), 'X', null, 20_000, { quiet: true });
    expect(t.steps).toHaveLength(2);
    expect(t.index).toBe(0);
    expect(t.steps[0]!.spot.stop).toBe('faceplate');
    expect(canGoForward(t)).toBe(true);
    // ...but quiet never swallows a real change of thing.
    const t2 = visit(t, spot({ selection: sel('z') }), 'Z', null, 20_100, { quiet: true });
    expect(t2.steps).toHaveLength(2);
    expect(t2.steps.map((s) => s.label)).toEqual(['X', 'Z']);
  });
});

describe('back and forward', () => {
  const t0 = walkTo([spot(), spot({ selection: sel('a') }), spot({ selection: sel('b') })]);

  it('goes back one step at a time and forward again', () => {
    const b1 = back(t0)!;
    expect(b1.step.label).toBe('S1');
    expect(b1.trail.index).toBe(1);
    expect(canGoForward(b1.trail)).toBe(true);
    const b2 = back(b1.trail)!;
    expect(b2.step.label).toBe('S0');
    expect(back(b2.trail)).toBeNull();
    const f1 = forward(b2.trail)!;
    expect(f1.step.label).toBe('S1');
    expect(forward(forward(b2.trail)!.trail)!.step.label).toBe('S2');
    expect(forward(t0)).toBeNull();
  });

  it('skips a step that is no longer any good', () => {
    const b = back(t0, (s) => s.label !== 'S1')!;
    expect(b.step.label).toBe('S0');
    expect(b.trail.index).toBe(0);
    expect(back(t0, () => false)).toBeNull();
  });

  it('a new step after going back drops what was ahead', () => {
    const wentBack = back(t0)!.trail;
    const t = visit(wentBack, spot({ selection: sel('c') }), 'C', null, 90_000);
    expect(t.steps.map((s) => s.label)).toEqual(['S0', 'S1', 'C']);
    expect(canGoForward(t)).toBe(false);
  });

  it('jumps straight to a chip', () => {
    expect(jumpTo(t0, 0)!.step.label).toBe('S0');
    expect(jumpTo(t0, 2)).toBeNull();
    expect(jumpTo(t0, 7)).toBeNull();
  });
});

describe('camera and saved views', () => {
  it('keeps the camera of the step it is left at', () => {
    let t = walkTo([spot(), spot({ selection: sel('a') })]);
    t = withCamera(t, { x: 1, y: 2, zoom: 3 });
    expect(t.steps[1]!.camera).toEqual({ x: 1, y: 2, zoom: 3 });
    expect(t.steps[0]!.camera).toBeNull();
    expect(withCamera(t, { x: 1, y: 2, zoom: 3 })).toBe(t);
    expect(back(t)!.step.camera).toBeNull();
  });

  it('a saved view is a step even at the same place', () => {
    let t = walkTo([spot()]);
    t = addStep(t, spot(), 'CORE RACK', { x: 5, y: 5, zoom: 1 }, 50_000);
    expect(t.steps.map((s) => s.label)).toEqual(['S0', 'CORE RACK']);
    expect(t.index).toBe(1);
    expect(back(t)!.step.label).toBe('S0');
  });
});

describe('chips', () => {
  it('shows the whole trail when it is short, with the current one marked', () => {
    const t = walkTo([spot(), spot({ selection: sel('a') }), spot({ selection: sel('b') })]);
    const w = chipWindow(t);
    expect(w.chips.map((c) => c.label)).toEqual(['S0', 'S1', 'S2']);
    expect(w.chips.map((c) => c.current)).toEqual([false, false, true]);
    expect(w.before).toBe(0);
    expect(w.after).toBe(0);
  });

  it('shows five around the current one in a long trail, and counts the rest', () => {
    const t0 = walkTo(Array.from({ length: 10 }, (_, i) => spot({ selection: sel(`r${i}`) })));
    const w = chipWindow(t0);
    expect(w.chips).toHaveLength(5);
    expect(w.chips.at(-1)!.current).toBe(true);
    expect(w.before).toBe(5);
    expect(w.after).toBe(0);
    const mid = chipWindow({ ...t0, index: 4 });
    expect(mid.chips.some((c) => c.current && c.index === 4)).toBe(true);
    expect(mid.before + mid.chips.length + mid.after).toBe(10);
  });

  it('writes the words in capitals', () => {
    expect(stepLabel({ name: 'switch-1', look: 'rack', jot: false, stop: 'faceplate' })).toBe('SWITCH-1 · FACEPLATE');
    expect(stepLabel({ name: 'R1', look: 'rack', jot: false, stop: 'rack' })).toBe('R1');
    expect(stepLabel({ name: '', look: 'rack', jot: false, stop: 'closet' })).toBe('OVERVIEW');
    expect(stepLabel({ name: 'R1', look: 'diagram', jot: false, stop: 'rack' })).toBe('R1 · DIAGRAM');
    expect(stepLabel({ name: 'sw', look: 'rack', jot: true, stop: 'inside' })).toBe('SW · OPEN');
  });
});
