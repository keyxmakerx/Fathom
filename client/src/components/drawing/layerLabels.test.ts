import { describe, expect, it } from 'vitest';

import { createSketchDevice } from '../../document/commands';
import { emptyDocument, parseNodeId } from '../../document/model';
import { tagObject } from '../../document/tags';
import type { ClosetView } from './contract';
import { cableCandidates, vlanWord, layerWords, placeLabels, type Candidate } from './layerLabels';
import { defaultLayers } from './layers';

const cand = (key: string, x: number, priority = 1, text = 'VLAN 20'): Candidate => ({ key, text, x, y: 0, ax: 'start', priority });

describe('placeLabels', () => {
  it('hides the lower priority label and counts it', () => {
    const out = placeLabels([cand('low', 0, 1), cand('high', 10, 0)], []);
    expect(out.map((l) => l.key)).toEqual(['high']);
    expect(out[0]!.more).toBe(1);
  });
  it('keeps labels that do not touch', () => {
    expect(placeLabels([cand('a', 0), cand('b', 500)], [])).toHaveLength(2);
  });
  it('drops a label that would cover a box', () => {
    expect(placeLabels([cand('a', 0)], [{ x: 10, y: -10, w: 50, h: 20 }])).toHaveLength(0);
  });
  it('zooming out grows the footprint in flow units', () => {
    expect(placeLabels([cand('a', 0), cand('b', 100)], [], 1)).toHaveLength(2);
    expect(placeLabels([cand('a', 0), cand('b', 100)], [], 4)).toHaveLength(1);
  });
});

describe('vlanWord', () => {
  it('says TRUNK only for more than one VLAN', () => {
    expect(vlanWord([20], true)).toBe('VLAN 20');
    expect(vlanWord([30, 10, 20, 10], true)).toBe('TRUNK 10,20,30');
  });
});

describe('cableCandidates', () => {
  const pt = (x: number, y: number, dx: number, dy: number) => ({ x, y, dx, dy });
  it('keeps a bent route\'s VLAN word off the line', () => {
    const c = cableCandidates([{ id: 'c', route: { a: pt(0, 0, 1, 0), b: pt(100, 80, -1, 0) } }], new Map([['c', { mid: 'VLAN 20' }]]), 1);
    expect(c[0]!.x).toBeGreaterThan(50);
    expect(c[0]!.ax).toBe('start');
  });
  it('puts the VLAN word mid-line and an address at each end', () => {
    const c = cableCandidates([{ id: 'c', route: { a: pt(0, 0, 0, 1), b: pt(0, 100, 0, -1) } }], new Map([['c', { mid: 'VLAN 20', a: '10.0.0.1' }]]), 1);
    expect(c.map((x) => x.key).sort()).toEqual(['c:a', 'c:mid']);
    expect(c.find((x) => x.key === 'c:mid')!.y).toBe(50);
  });
});

describe('layerWords', () => {
  const view = (deviceId: string): ClosetView =>
    ({ racks: [{ chassis: [{ id: 'ch1', deviceId, ports: [] }] }], cables: [] }) as unknown as ClosetView;
  it('is empty with every layer off', () => {
    const w = layerWords(emptyDocument(), view('d'), defaultLayers());
    expect(w.cables.size + w.devices.size).toBe(0);
  });
  it('writes a device its tags', () => {
    let doc = createSketchDevice(emptyDocument(), { now: 1 });
    const deviceId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Device')!.id;
    doc = tagObject(doc, deviceId, 'core', { now: 2 });
    const w = layerWords(doc, view(deviceId), { ...defaultLayers(), tags: true });
    expect(w.devices.get('ch1')).toEqual(['core']);
  });
});
