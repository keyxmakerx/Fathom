// The Links lens's marks (sign-off r109): VLAN colour on access lines, hollow trunks, weight by speed.
import { describe, expect, it } from 'vitest';

import { connectPorts } from '../../document/cables';
import { addSketchPort, createSketchDevice } from '../../document/commands';
import { begin, finish, moveFree, setNodeField } from '../../document/freeform';
import { edgesOut, emptyDocument, findNode, parseNodeId, type Document } from '../../document/model';
import { addVlan } from '../../document/networks';
import { viewOf } from '../../document/view';
import { linksMarks, speedText, speedWidth, TRUNK_MIN_W } from './linksLens';

function addDevice(doc: Document, ports: string[]) {
  const before = new Set(doc.nodes.map((n) => n.id));
  let next = createSketchDevice(doc);
  const fresh = next.nodes.filter((n) => !before.has(n.id));
  const deviceId = fresh.find((n) => parseNodeId(n.id).kind === 'Device')!.id;
  const chassisId = fresh.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
  const portIds: string[] = [];
  for (const label of ports) {
    const had = new Set(next.nodes.map((n) => n.id));
    next = addSketchPort(next, chassisId, { label, connector: 'rj45', face: 'front' });
    portIds.push(next.nodes.find((n) => !had.has(n.id))!.id);
  }
  return { doc: next, deviceId, chassisId, portIds };
}

/** Switch s: port 1 to pc a in VLAN 20 (access); port 2 to switch t carrying VLANs 20 and 30; port 3 to b, no VLAN. */
function design() {
  const s = addDevice(emptyDocument(), ['1', '2', '3']);
  const a = addDevice(s.doc, ['eth0']);
  const t = addDevice(a.doc, ['1']);
  const b = addDevice(t.doc, ['eth0']);
  let doc = connectPorts(b.doc, s.portIds[0], a.portIds[0], { sheath: 'grey' });
  doc = connectPorts(doc, s.portIds[1], t.portIds[0], { sheath: 'grey' });
  doc = connectPorts(doc, s.portIds[2], b.portIds[0], { sheath: 'grey' });
  doc = addVlan(doc, { vlanId: 20, name: 'users', attach: [{ target: { kind: 'port', portId: s.portIds[0], interfaceName: '1' } }, { target: { kind: 'port', portId: s.portIds[1], interfaceName: '2' } }] });
  doc = addVlan(doc, { vlanId: 30, attach: [{ target: { kind: 'port', portId: t.portIds[0], interfaceName: '1' } }] });
  doc = moveFree(doc, [s, a, t, b].map((x, i) => ({ id: x.chassisId, x: i * 200, y: 0 })));
  return { doc, s, a, t, b };
}

function cableAt(doc: Document, portId: string): string {
  const view = viewOf(doc, []);
  return view.cables.find((c) => c.ends.some((e) => 'portId' in e && e.portId === portId))!.id;
}

function setSpeed(doc: Document, deviceId: string, name: string, bps: number): Document {
  const iface = edgesOut(doc, deviceId, 'HasInterface').map((e) => findNode(doc, e.to)!).find((n) => n.fields['Interface.name']?.value === name)!;
  const b = begin(doc, undefined);
  setNodeField(b, iface.id, 'Interface.speed', bps);
  return finish(b, 'speed');
}

describe('the Links lens', () => {
  it('colours an access line by its VLAN and draws a trunk hollow', () => {
    const { doc, s } = design();
    const marks = linksMarks(doc, viewOf(doc, []));
    const access = marks.cables.get(cableAt(doc, s.portIds[0]))!;
    expect(access).toMatchObject({ vlans: [20], trunk: false, slot: 1 });
    const trunk = marks.cables.get(cableAt(doc, s.portIds[1]))!;
    expect(trunk.vlans).toEqual([20, 30]);
    expect(trunk.trunk).toBe(true);
    expect(trunk.slot).toBeNull();
    // A line with no VLAN and no speed is left as it is.
    expect(marks.cables.has(cableAt(doc, s.portIds[2]))).toBe(false);
  });

  it('lists each VLAN once in the Networks key, in id order, with its colour', () => {
    const { doc } = design();
    const { key } = linksMarks(doc, viewOf(doc, []));
    expect(key.map((r) => [r.vlanId, r.slot, r.name])).toEqual([
      [20, 1, 'users'],
      [30, 2, undefined],
    ]);
  });

  it('weighs a line by the slower end of its speed', () => {
    let { doc, s, t } = design();
    doc = setSpeed(doc, s.deviceId, '2', 10e9);
    expect(linksMarks(doc, viewOf(doc, [])).cables.get(cableAt(doc, s.portIds[1]))?.speedBps).toBe(10e9);
    doc = setSpeed(doc, t.deviceId, '1', 1e9);
    expect(linksMarks(doc, viewOf(doc, [])).cables.get(cableAt(doc, s.portIds[1]))?.speedBps).toBe(1e9);
  });

  it('draws faster thicker, and a trunk wide enough for its core', () => {
    expect(speedWidth(null)).toBe(1.2);
    expect(speedWidth(100e6)).toBeLessThan(speedWidth(1e9));
    expect(speedWidth(1e9)).toBeLessThan(speedWidth(2.5e9));
    expect(speedWidth(2.5e9)).toBeLessThan(speedWidth(10e9));
    expect(TRUNK_MIN_W).toBeGreaterThan(speedWidth(2.5e9));
    expect([speedText(10e9), speedText(2.5e9), speedText(1e9), speedText(100e6)]).toEqual(['10G', '2.5G', '1G', '100M']);
  });

  it('marks nothing without a design', () => {
    const { doc } = design();
    expect(linksMarks(null, viewOf(doc, [])).cables.size).toBe(0);
  });
});
