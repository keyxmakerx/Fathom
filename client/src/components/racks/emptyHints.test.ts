import { describe, expect, it } from 'vitest';

import { addSketchPort, createRack, createShelf, createSketchDevice, movePlacement, placeOnShelf } from '../../document/commands';
import { emptyDocument, formatNodeId, parseNodeId, type Document } from '../../document/model';
import { newUlid } from '../../document/ulid';
import { viewOf } from '../../document/view';
import { autoOpenEquipment, designHasNoDevices } from './emptyHints';

const NOW = 1_700_000_000_000;

function withRack(): Document {
  const premises = formatNodeId('Premises', newUlid(NOW));
  const doc: Document = {
    ...emptyDocument(),
    nodes: [{ id: premises, existence: newUlid(NOW), fields: { 'Premises.label': { presence: 'set', prov: newUlid(NOW), value: 'T' } } }],
  };
  return createRack(doc, premises, { label: 'R1', heightU: 42, unitNumbering: 'ascending', now: NOW });
}

function addDevice(doc: Document): { doc: Document; chassisId: string } {
  let dev = createSketchDevice(emptyDocument(), { now: NOW, hostname: 'sw' });
  const chassisId = dev.nodes.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
  dev = addSketchPort(dev, chassisId, { label: 'Et1', connector: 'rj45', face: 'front' }, { now: NOW });
  return { doc: { ...doc, nodes: [...doc.nodes, ...dev.nodes], edges: [...doc.edges, ...dev.edges], provenance: [...doc.provenance, ...dev.provenance], batches: [...doc.batches, ...dev.batches] }, chassisId };
}

describe('designHasNoDevices', () => {
  it('is true for a blank design and for a rack with nothing in it', () => {
    expect(designHasNoDevices(viewOf(emptyDocument(), []))).toBe(true);
    expect(designHasNoDevices(viewOf(withRack(), []))).toBe(true);
  });

  it('is false once a device is racked', () => {
    let doc = withRack();
    const rackId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Rack')!.id;
    const added = addDevice(doc);
    doc = movePlacement(added.doc, added.chassisId, { kind: 'rack', rackId, positionU: 1, face: 'front' }, { now: NOW });
    expect(designHasNoDevices(viewOf(doc, []))).toBe(false);
  });

  it('is false for a device on a shelf and for one unplaced, but true for an empty shelf', () => {
    const doc = withRack();
    const rackId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Rack')!.id;
    const shelved = createShelf(doc, rackId, { label: 'S', positionU: 5, now: NOW });
    expect(designHasNoDevices(viewOf(shelved, []))).toBe(true);
    const shelfId = shelved.nodes.find((n) => parseNodeId(n.id).kind === 'PassiveNode')!.id;
    const added = addDevice(shelved);
    expect(designHasNoDevices(viewOf(placeOnShelf(added.doc, added.chassisId, shelfId, 1, { now: NOW }), []))).toBe(false);
    expect(designHasNoDevices(viewOf(addDevice(withRack()).doc, []))).toBe(false);
  });
});

describe('autoOpenEquipment', () => {
  const empty = viewOf(emptyDocument(), []);
  const full = viewOf(addDevice(withRack()).doc, []);

  it('does not know until the design has loaded', () => {
    expect(autoOpenEquipment(false, true, empty)).toBeUndefined();
  });
  it('says open for an empty design a person can draw in', () => {
    expect(autoOpenEquipment(true, true, empty)).toBe(true);
  });
  it('says no for a reader (there is no Equipment list for them) and for a design with devices', () => {
    expect(autoOpenEquipment(true, false, empty)).toBe(false);
    expect(autoOpenEquipment(true, true, full)).toBe(false);
  });
});
