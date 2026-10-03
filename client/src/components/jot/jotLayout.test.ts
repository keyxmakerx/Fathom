import { describe, expect, it } from 'vitest';

import { connectPorts } from '../../document/cables';
import { addSketchPort } from '../../document/commands';
import { createFreeBox } from '../../document/freeform';
import { emptyDocument, type Document } from '../../document/model';
import { viewOf } from '../../document/view';
import { boundsOf, jotPlates, jotSpot, originOf, PLATE_W } from './jotLayout';

function box(doc: Document, hostname: string, x: number, y: number): { doc: Document; chassisId: string } {
  const made = createFreeBox(doc, { x, y, hostname });
  const withPort = addSketchPort(made.doc, made.chassisId, { label: '1', connector: 'rj45', face: 'front' });
  return { doc: withPort, chassisId: made.chassisId };
}

describe('jot layout', () => {
  it('puts the device at the origin and shows free boxes near it, relative to it', () => {
    const a = box(emptyDocument(), 'a', 100, 100);
    const b = box(a.doc, 'b', 400, 100);
    const view = viewOf(b.doc, []);
    const plates = jotPlates(view, a.chassisId, { x: 0, y: 0 })!;
    expect(plates.map((p) => [p.chassis.hostname, p.x, p.y])).toEqual([['a', 0, 0], ['b', 300, 0]]);
    expect(plates[0]!.isDevice).toBe(true);
  });

  it('leaves out a box far away unless a cable joins it to the device', () => {
    const a = box(emptyDocument(), 'a', 0, 0);
    const far = box(a.doc, 'far', 3000, 3000);
    expect(jotPlates(viewOf(far.doc, []), a.chassisId, { x: 0, y: 0 })!.length).toBe(1);
    const view = viewOf(far.doc, []);
    const [pa, pf] = [view.unplaced.find((c) => c.id === a.chassisId)!.ports[0]!.id, view.unplaced.find((c) => c.id === far.chassisId)!.ports[0]!.id];
    const cabled = viewOf(connectPorts(far.doc, pa, pf, { sheath: 'grey' }), []);
    expect(cabled.cables[0]!.ends).toHaveLength(2);
    expect(jotPlates(cabled, a.chassisId, { x: 0, y: 0 })!.length).toBe(2);
  });

  it('answers null for a device that is not there', () => {
    expect(jotPlates(viewOf(emptyDocument(), []), 'chassis:none', { x: 0, y: 0 })).toBeNull();
  });

  it('places the next box clear of every plate, down the right side', () => {
    const a = box(emptyDocument(), 'a', 0, 0);
    const view = viewOf(a.doc, []);
    const plates = jotPlates(view, a.chassisId, { x: 0, y: 0 })!;
    const first = jotSpot(plates);
    expect(first.x).toBeGreaterThanOrEqual(PLATE_W);
    const taken = [...plates, { ...plates[0]!, x: first.x, y: first.y, isDevice: false }];
    expect(jotSpot(taken).y).toBeGreaterThan(first.y);
  });

  it('uses a free box device’s own pin as its place, and the given place for a racked one', () => {
    const a = box(emptyDocument(), 'a', 120, 80);
    const view = viewOf(a.doc, []);
    expect(originOf(view, a.chassisId, { x: 1, y: 2 })).toEqual({ x: 120, y: 80 });
    expect(originOf(view, 'chassis:racked', { x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
    expect(boundsOf(jotPlates(view, a.chassisId, { x: 0, y: 0 })!).w).toBe(PLATE_W);
  });
});
