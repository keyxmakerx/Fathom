import { describe, expect, it } from 'vitest';

import { removeChassis } from './commands';
import {
  createFreeBox,
  createLabel,
  createLine,
  lineEnds,
  linesBetween,
  moveFree,
  pinOf,
  removeFree,
  setLabel,
  setLineLabel,
  snap,
} from './freeform';
import { emptyDocument, findNode, type Document } from './model';
import { undo } from './undo';
import { viewOf } from './view';

const ACTOR = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
let t = 1_790_500_000_000;
const step = () => ({ actor: ACTOR, now: (t += 1000) });
const live = (doc: Document, id: string) => findNode(doc, id)?.absentSince === undefined;

function twoBoxes(): { doc: Document; a: string; b: string } {
  const first = createFreeBox(emptyDocument(), { role: 'router', hostname: 'router-1', x: 40, y: 40, ...step() });
  const second = createFreeBox(first.doc, { role: 'switch', hostname: 'switch-1', x: 300, y: 40, ...step() });
  return { doc: second.doc, a: first.chassisId, b: second.chassisId };
}

describe('free boxes', () => {
  it('a new box is pinned on the 4 px grid and shows up as a free box with its role', () => {
    const { doc, chassisId } = createFreeBox(emptyDocument(), { role: 'switch', hostname: 'switch-1', x: 41, y: 50, ...step() });
    expect(pinOf(doc, chassisId)).toEqual({ x: snap(41), y: snap(50) });
    expect(snap(41)).toBe(40);
    const view = viewOf(doc, []);
    expect(view.free).toEqual([{ id: chassisId, hostname: 'switch-1', role: 'switch', model: '', x: 40, y: 52, portCount: 0 }]);
    expect(view.unplaced.map((c) => c.id)).toContain(chassisId);
  });

  it('is one undo step', () => {
    const { doc } = createFreeBox(emptyDocument(), { role: 'router', x: 0, y: 0, ...step() });
    expect(doc.batches).toHaveLength(1);
    const undone = undo(doc, doc.batches[0]!.id, step());
    expect(viewOf(undone, []).free).toEqual([]);
  });

  it('moves several together as one step, and a move to the same spot writes nothing', () => {
    const { doc, a, b } = twoBoxes();
    const moved = moveFree(doc, [{ id: a, x: 100, y: 100 }, { id: b, x: 200, y: 100 }], step());
    expect(moved.batches).toHaveLength(doc.batches.length + 1);
    expect(pinOf(moved, a)).toEqual({ x: 100, y: 100 });
    expect(pinOf(moved, b)).toEqual({ x: 200, y: 100 });
    expect(moveFree(moved, [{ id: a, x: 100, y: 100 }], step())).toBe(moved);
  });

  it('a pin can sit left of and above the origin', () => {
    const { doc, chassisId } = createFreeBox(emptyDocument(), { x: -120, y: -8, ...step() });
    expect(pinOf(doc, chassisId)).toEqual({ x: -120, y: -8 });
  });
});

describe('lines', () => {
  it('joins two boxes, once', () => {
    const { doc, a, b } = twoBoxes();
    const { doc: joined, id } = createLine(doc, a, b, step());
    expect(lineEnds(joined, id)).toEqual([a, b]);
    expect(linesBetween(joined, b, a)).toEqual([id]);
    expect(viewOf(joined, []).lines).toEqual([{ id, aId: a, bId: b, label: null }]);
    expect(() => createLine(joined, b, a, step())).toThrow(/already joined/);
    expect(() => createLine(doc, a, a, step())).toThrow(/two different/);
  });

  it('carries a label that can be cleared', () => {
    const { doc, a, b } = twoBoxes();
    const { doc: joined, id } = createLine(doc, a, b, step());
    const named = setLineLabel(joined, id, 'uplink', step());
    expect(viewOf(named, []).lines[0]!.label).toBe('uplink');
    expect(viewOf(setLineLabel(named, id, null, step()), []).lines[0]!.label).toBeNull();
  });

  it('goes when either box is removed, by removeFree or by removeChassis, and comes back with undo', () => {
    const { doc, a, b } = twoBoxes();
    const { doc: joined, id } = createLine(doc, a, b, step());
    const gone = removeFree(joined, [a], step());
    expect(live(gone, id)).toBe(false);
    expect(live(gone, b)).toBe(true);
    expect(viewOf(gone, []).free.map((f) => f.id)).toEqual([b]);
    const viaChassis = removeChassis(joined, b, step());
    expect(live(viaChassis, id)).toBe(false);
    const back = undo(gone, gone.batches.at(-1)!.id, step());
    expect(live(back, id)).toBe(true);
    expect(viewOf(back, []).lines).toHaveLength(1);
  });
});

describe('labels and areas', () => {
  it('a text label and an area are views with a position; an area has a size with a floor', () => {
    let doc = emptyDocument();
    const text = createLabel(doc, { text: 'Floor 2', form: 'text', x: 8, y: 8, ...step() });
    const area = createLabel(text.doc, { text: 'Guest', form: 'area', x: 200, y: 200, w: 10, h: 10, ...step() });
    doc = area.doc;
    const labels = viewOf(doc, []).labels;
    expect(labels.find((l) => l.id === text.id)).toMatchObject({ text: 'Floor 2', form: 'text', x: 8, y: 8 });
    expect(labels.find((l) => l.id === area.id)).toMatchObject({ form: 'area', w: 96, h: 64 });
    const edited = setLabel(doc, area.id, { text: 'Guest wifi', w: 300 }, step());
    expect(viewOf(edited, []).labels.find((l) => l.id === area.id)).toMatchObject({ text: 'Guest wifi', w: 300, h: 64 });
    const removed = removeFree(edited, [area.id], step());
    expect(viewOf(removed, []).labels.map((l) => l.id)).toEqual([text.id]);
  });
});
