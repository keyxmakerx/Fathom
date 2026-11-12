// A port's configured speed (sign-off r109, item 5): read, set, cleared, and refused in words.
import { describe, expect, it } from 'vitest';

import { addSketchPort, createSketchDevice } from './commands';
import { FieldValueError } from './edit';
import { edgesIn, emptyDocument, findNode, parseNodeId, type Document } from './model';
import { addVlan } from './networks';
import { parseSpeed, portInterface, portSpeed, setPortSpeed } from './portSpeed';
import { viewOf } from './view';

function device(): { doc: Document; deviceId: string; portId: string } {
  let doc = createSketchDevice(emptyDocument());
  const deviceId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Device')!.id;
  const chassisId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
  doc = addSketchPort(doc, chassisId, { label: 'ge-0/0/1', connector: 'rj45', face: 'front' });
  const portId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'PhysicalPort')!.id;
  return { doc, deviceId, portId };
}

describe('a port speed', () => {
  it('reads the usual spellings', () => {
    expect(parseSpeed('10G')).toBe(10e9);
    expect(parseSpeed('2.5g')).toBe(2.5e9);
    expect(parseSpeed('100M')).toBe(100e6);
    expect(parseSpeed('10 Gb/s')).toBe(10e9);
    expect(parseSpeed('1Gbps')).toBe(1e9);
    expect(parseSpeed('1000000000')).toBe(1e9);
    expect(parseSpeed('fast')).toBeNull();
    expect(parseSpeed('0')).toBeNull();
  });

  it('gives a hand-drawn port an interface named after it, and stores the digits', () => {
    const { doc, portId } = device();
    expect(portInterface(doc, portId)).toBeUndefined();
    const next = setPortSpeed(doc, portId, '10G');
    const iface = portInterface(next, portId)!;
    expect(findNode(next, iface)!.fields['Interface.name']!.value).toBe('ge-0/0/1');
    expect(findNode(next, iface)!.fields['Interface.speed']!.value).toBe('10000000000');
    expect(edgesIn(next, portId, 'Occupies').map((e) => e.from)).toEqual([iface]);
    expect(portSpeed(next, portId)).toBe(10e9);
    expect(next.batches.length).toBe(doc.batches.length + 1);
  });

  it('uses the interface a VLAN already gave the port', () => {
    const { doc, portId } = device();
    const withVlan = addVlan(doc, { vlanId: 20, attach: [{ target: { kind: 'port', portId, interfaceName: 'ge-0/0/1' } }] });
    const before = portInterface(withVlan, portId);
    const next = setPortSpeed(withVlan, portId, '1G');
    expect(portInterface(next, portId)).toBe(before);
    expect(portSpeed(next, portId)).toBe(1e9);
  });

  it('clears it, and clearing a port with no interface changes nothing', () => {
    const { doc, portId } = device();
    expect(setPortSpeed(doc, portId, '')).toBe(doc);
    const set = setPortSpeed(doc, portId, '1G');
    const cleared = setPortSpeed(set, portId, null);
    expect(portSpeed(cleared, portId)).toBeNull();
  });

  it('refuses a word that is not a speed', () => {
    const { doc, portId } = device();
    expect(() => setPortSpeed(doc, portId, 'quick')).toThrow(FieldValueError);
  });

  it('shows on the port in the view', () => {
    const { doc, portId } = device();
    const next = setPortSpeed(doc, portId, '2.5G');
    const port = [...viewOf(next, []).unplaced!.flatMap((c) => c.ports)].find((p) => p.id === portId)!;
    expect(port.speedBps).toBe(2.5e9);
  });
});
