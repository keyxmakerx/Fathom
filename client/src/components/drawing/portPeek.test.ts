import { describe, expect, it } from 'vitest';

import { connectPorts, setCableField } from '../../document/cables';
import { addSketchPort, createRack, createSketchDevice, movePlacement } from '../../document/commands';
import { emptyDocument, formatNodeId, parseNodeId, type Document } from '../../document/model';
import { addVlan } from '../../document/networks';
import { newUlid } from '../../document/ulid';
import { viewOf } from '../../document/view';
import { portPeek } from './portPeek';

const NOW = 1_700_000_000_000;

interface Scene {
  doc: Document;
  /** port ids: [switch Et1, switch Et2, ap eth0] */
  ports: string[];
}

function scene(): Scene {
  const premises = formatNodeId('Premises', newUlid(NOW));
  let doc: Document = {
    ...emptyDocument(),
    nodes: [{ id: premises, existence: newUlid(NOW), fields: { 'Premises.label': { presence: 'set', prov: newUlid(NOW), value: 'T' } } }],
  };
  doc = createRack(doc, premises, { label: 'R1', heightU: 42, unitNumbering: 'ascending', now: NOW });
  const rackId = doc.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Rack')!.id;
  const ports: string[] = [];
  const devices: Array<[string, string[]]> = [
    ['switch-1', ['Et1', 'Et2']],
    ['ap-lobby', ['eth0']],
  ];
  devices.forEach(([hostname, labels], d) => {
    let dev = createSketchDevice(emptyDocument(), { now: NOW, hostname });
    const chassisId = dev.nodes.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
    for (const label of labels) {
      const before = new Set(dev.nodes.map((n) => n.id));
      dev = addSketchPort(dev, chassisId, { label, connector: 'rj45', face: 'front' }, { now: NOW });
      ports.push(dev.nodes.find((n) => !before.has(n.id) && parseNodeId(n.id).kind === 'PhysicalPort')!.id);
    }
    doc = { ...doc, nodes: [...doc.nodes, ...dev.nodes], edges: [...doc.edges, ...dev.edges], provenance: [...doc.provenance, ...dev.provenance], batches: [...doc.batches, ...dev.batches] };
    doc = movePlacement(doc, chassisId, { kind: 'rack', rackId, positionU: 1 + d, face: 'front' }, { now: NOW });
  });
  return { doc, ports };
}

describe('portPeek', () => {
  it('says "Not connected" for a free port, with the port label as the title', () => {
    const { doc, ports } = scene();
    const card = portPeek(doc, viewOf(doc, []), ports[1]!);
    expect(card).not.toBeNull();
    expect(card!.title).toBe('Et2');
    expect(card!.rows).toEqual([
      { key: 'To', value: 'Not connected', empty: true },
      { key: 'VLAN', value: 'No VLAN', empty: true },
      { key: 'Cable', value: 'No cable', empty: true },
    ]);
  });

  it('names the far end, the cable and its length', () => {
    const s = scene();
    let doc = connectPorts(s.doc, s.ports[0]!, s.ports[2]!, { label: 'C-114' }, { now: NOW });
    const cableId = doc.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Cable')!.id;
    doc = setCableField(doc, cableId, 'length_m', 12, { now: NOW });
    const view = viewOf(doc, []);
    const near = portPeek(doc, view, s.ports[0]!)!;
    expect(near.title).toBe('Et1');
    expect(near.rows.find((r) => r.key === 'To')).toEqual({ key: 'To', value: 'ap-lobby · eth0', empty: false });
    expect(near.rows.find((r) => r.key === 'Cable')).toEqual({ key: 'Cable', value: 'C-114 · 12 m', empty: false });
    // And the same cable read from the other end.
    const far = portPeek(doc, view, s.ports[2]!)!;
    expect(far.rows.find((r) => r.key === 'To')!.value).toBe('switch-1 · Et1');
  });

  it('falls back to the cable type when it has no label, and leaves out an unset length', () => {
    const s = scene();
    const doc = connectPorts(s.doc, s.ports[0]!, s.ports[2]!, {}, { now: NOW });
    const card = portPeek(doc, viewOf(doc, []), s.ports[0]!)!;
    const cable = card.rows.find((r) => r.key === 'Cable')!;
    expect(cable.empty).toBe(false);
    expect(cable.value).not.toContain(' m');
    expect(cable.value).not.toBe('');
  });

  it('shows the VLAN a cabled port carries, id and name', () => {
    const s = scene();
    let doc = connectPorts(s.doc, s.ports[0]!, s.ports[2]!, { label: 'C-114' }, { now: NOW });
    doc = addVlan(doc, { vlanId: 20, name: 'Staff', attach: [{ target: { kind: 'port', portId: s.ports[0]!, interfaceName: 'Et1' } }] }, { now: NOW });
    const card = portPeek(doc, viewOf(doc, []), s.ports[0]!)!;
    expect(card.rows.find((r) => r.key === 'VLAN')).toEqual({ key: 'VLAN', value: '20 Staff', empty: false });
  });

  it('knows nothing about a port that is not in the view', () => {
    const { doc } = scene();
    expect(portPeek(doc, viewOf(doc, []), 'physical-port:nope')).toBeNull();
  });

  it('still says what it can before the document has loaded', () => {
    const s = scene();
    const doc = connectPorts(s.doc, s.ports[0]!, s.ports[2]!, { label: 'C-1' }, { now: NOW });
    const card = portPeek(null, viewOf(doc, []), s.ports[0]!)!;
    expect(card.rows.find((r) => r.key === 'VLAN')!.value).toBe('No VLAN');
    expect(card.rows.find((r) => r.key === 'To')!.value).toBe('ap-lobby · eth0');
  });
});
