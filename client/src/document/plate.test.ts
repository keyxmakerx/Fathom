import { describe, expect, it } from 'vitest';

import { addFreeBoxDoc } from '../components/racks/freeActions';
import { deviceChassis } from '../components/jot/jotLayout';
import { layoutFaceplate, plateBoxAt } from '../components/drawing/faceplate';
import { addSketchPortRange, DuplicatePortLabelError, SketchOnCatalogueChassisError } from './commands';
import { emptyDocument, findNode, readPhysicalPortFields, type Document } from './model';
import { addTemplatePorts, placePorts, resetPortPlaces } from './plate';
import { viewOf } from './view';

function boxWithPorts(n: number): { doc: Document; chassisId: string } {
  const made = addFreeBoxDoc(emptyDocument(), null, 0, 0, undefined);
  const doc = addSketchPortRange(made.doc, made.chassisId, { labelPrefix: '', first: 1, last: n, connector: 'rj45', face: 'front' });
  return { doc, chassisId: made.chassisId };
}

const portsOf = (doc: Document, chassisId: string) => deviceChassis(viewOf(doc, []), chassisId)!.ports;

describe('ports placed on the plate (schema 0.19)', () => {
  it('writes plate_x and plate_y in one batch, and the view carries them', () => {
    const { doc, chassisId } = boxWithPorts(3);
    const [p1, p2] = portsOf(doc, chassisId);
    const next = placePorts(doc, chassisId, [
      { portId: p1!.id, x: 100, y: 250 },
      { portId: p2!.id, x: 1200, y: -4 },
    ]);
    expect(next.batches.length).toBe(doc.batches.length + 1);
    const fields = readPhysicalPortFields(findNode(next, p2!.id)!);
    expect(fields).toMatchObject({ plateX: 1000, plateY: 0 });
    const after = portsOf(next, chassisId);
    expect(after.find((p) => p.id === p1!.id)?.plate).toEqual({ x: 100, y: 250 });
    expect(after.find((p) => p.label === '3')?.plate).toBeUndefined();
  });

  it('writes nothing for a port already where it is asked to go', () => {
    const { doc, chassisId } = boxWithPorts(1);
    const [p] = portsOf(doc, chassisId);
    const once = placePorts(doc, chassisId, [{ portId: p!.id, x: 500, y: 500 }]);
    expect(placePorts(once, chassisId, [{ portId: p!.id, x: 500, y: 500 }])).toBe(once);
  });

  it('refuses a port on another box and a box with a catalogue model', () => {
    const a = boxWithPorts(1);
    const b = addFreeBoxDoc(a.doc, null, 300, 0, undefined);
    const [p] = portsOf(a.doc, a.chassisId);
    expect(() => placePorts(b.doc, b.chassisId, [{ portId: p!.id, x: 1, y: 1 }])).toThrow();
    const catalogued: Document = {
      ...a.doc,
      nodes: a.doc.nodes.map((n) => (n.id === a.chassisId ? { ...n, fields: { ...n.fields, 'Chassis.model': { presence: 'set', prov: n.existence, value: 'EX2300-24T' } } } : n)),
    };
    expect(() => placePorts(catalogued, a.chassisId, [{ portId: p!.id, x: 1, y: 1 }])).toThrow(SketchOnCatalogueChassisError);
  });

  it('resets every dragged port back to the computed layout in one step', () => {
    const { doc, chassisId } = boxWithPorts(2);
    const ports = portsOf(doc, chassisId);
    const placed = placePorts(doc, chassisId, ports.map((p, i) => ({ portId: p.id, x: 100 * (i + 1), y: 500 })));
    const reset = resetPortPlaces(placed, chassisId);
    expect(reset.batches.length).toBe(placed.batches.length + 1);
    expect(portsOf(reset, chassisId).every((p) => p.plate === undefined)).toBe(true);
  });

  it('lays a placed port out where it was put, kept on the plate, and leaves the rest where they were', () => {
    const { doc, chassisId } = boxWithPorts(4);
    const before = layoutFaceplate(portsOf(doc, chassisId), 2, 'box');
    const ports = portsOf(doc, chassisId);
    const placed = placePorts(doc, chassisId, [{ portId: ports[0]!.id, x: 0, y: 1000 }]);
    const after = layoutFaceplate(portsOf(placed, chassisId), 2, 'box');
    const moved = after.byId.get(ports[0]!.id)!;
    expect(moved.x).toBe(0);
    expect(moved.y + moved.h).toBeCloseTo(32);
    expect(after.byId.get(ports[1]!.id)).toEqual(before.byId.get(ports[1]!.id));
    expect(plateBoxAt({ x: 500, y: 500 }, 10, 10, 32)).toEqual({ x: 122 - 5, y: 11 });
  });
});

describe('a template added to a box', () => {
  it('adds every port in one batch, with its plate spot, service and face', () => {
    const made = addFreeBoxDoc(emptyDocument(), null, 0, 0, undefined);
    const next = addTemplatePorts(made.doc, made.chassisId, [
      { label: '1', connector: 'rj45', face: 'front', plate: { x: 100, y: 300 } },
      { label: '2', connector: 'rj45', face: 'front', service: 'ethernet' },
      { label: 'C', connector: 'c14', face: 'rear', service: 'power' },
    ]);
    expect(next.batches.length).toBe(made.doc.batches.length + 1);
    const ports = portsOf(next, made.chassisId);
    expect(ports.map((p) => [p.label, p.connector, p.face, p.service ?? null, p.plate ?? null])).toEqual([
      ['1', 'rj45', 'front', null, { x: 100, y: 300 }],
      ['2', 'rj45', 'front', 'ethernet', null],
      ['C', 'c14', 'rear', 'power', null],
    ]);
  });

  it('refuses a label the box already has, writing nothing', () => {
    const { doc, chassisId } = boxWithPorts(2);
    expect(() => addTemplatePorts(doc, chassisId, [{ label: '2', connector: 'rj45', face: 'front' }])).toThrow(DuplicatePortLabelError);
  });

  it('refuses a connector the schema does not know', () => {
    const made = addFreeBoxDoc(emptyDocument(), null, 0, 0, undefined);
    expect(() => addTemplatePorts(made.doc, made.chassisId, [{ label: '1', connector: 'usb', face: 'front' }])).toThrow(/connector/);
  });
});
