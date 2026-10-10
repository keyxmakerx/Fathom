import { describe, expect, it } from 'vitest';

import { connectPorts } from '../../document/cables';
import { addSketchPort, createRack, createSketchDevice, movePlacement } from '../../document/commands';
import { emptyDocument, formatNodeId, parseNodeId, type Document } from '../../document/model';
import { newUlid } from '../../document/ulid';
import { viewOf } from '../../document/view';
import { selectionName } from './selectionName';

const NOW = 1_700_000_000_000;

function scene() {
  const premises = formatNodeId('Premises', newUlid(NOW));
  let doc: Document = {
    ...emptyDocument(),
    nodes: [{ id: premises, existence: newUlid(NOW), fields: { 'Premises.label': { presence: 'set', prov: newUlid(NOW), value: 'T' } } }],
  };
  doc = createRack(doc, premises, { label: 'R1', heightU: 42, unitNumbering: 'ascending', now: NOW });
  const rackId = doc.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Rack')!.id;
  const ids: Array<{ chassisId: string; portId: string }> = [];
  ['switch-1', 'ap-1'].forEach((hostname, d) => {
    let dev = createSketchDevice(emptyDocument(), { now: NOW, hostname });
    const chassisId = dev.nodes.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
    dev = addSketchPort(dev, chassisId, { label: 'Et1', connector: 'rj45', face: 'front' }, { now: NOW });
    const portId = dev.nodes.find((n) => parseNodeId(n.id).kind === 'PhysicalPort')!.id;
    doc = { ...doc, nodes: [...doc.nodes, ...dev.nodes], edges: [...doc.edges, ...dev.edges], provenance: [...doc.provenance, ...dev.provenance], batches: [...doc.batches, ...dev.batches] };
    doc = movePlacement(doc, chassisId, { kind: 'rack', rackId, positionU: 1 + d, face: 'front' }, { now: NOW });
    ids.push({ chassisId, portId });
  });
  doc = connectPorts(doc, ids[0]!.portId, ids[1]!.portId, { label: 'C-9' }, { now: NOW });
  const cableId = doc.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Cable')!.id;
  return { view: viewOf(doc, []), rackId, ids, cableId };
}

describe('selectionName', () => {
  it('names a rack, a device, a port and a cable', () => {
    const { view, rackId, ids, cableId } = scene();
    expect(selectionName(view, { kind: 'rack', id: rackId })).toBe('R1');
    expect(selectionName(view, { kind: 'chassis', id: ids[0]!.chassisId })).toBe('switch-1');
    expect(selectionName(view, { kind: 'port', id: ids[0]!.portId })).toBe('Et1');
    expect(selectionName(view, { kind: 'cable', id: cableId })).toBe('C-9');
  });

  it('is empty when nothing is selected, and plain when the thing is gone', () => {
    const { view } = scene();
    expect(selectionName(view, null)).toBe('');
    expect(selectionName(view, { kind: 'chassis', id: 'chassis:gone' })).toBe('Device');
    expect(selectionName(view, { kind: 'rack', id: 'rack:gone' })).toBe('Rack');
  });
});
