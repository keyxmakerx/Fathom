import { describe, expect, it } from 'vitest';

import type { CatalogueModel, CataloguePort } from '../api/catalogue';
import { applyEditorChange } from '../components/design/applyChange';
import { swapSummary } from '../components/drawing/Editor';
import { addFreeBoxDoc } from '../components/racks/freeActions';
import { createPremises } from '../components/racks/emptyDesign';
import { connectOneEnd, connectPorts } from './cables';
import { addSketchPortRange, createRack, placeChassis } from './commands';
import { setChassisField } from './edit';
import { addEdge, addNode, begin, finish } from './freeform';
import { edgesIn, edgesOut, emptyDocument, findNode, interfaceName, token, readChassisFields, readMountedInFields, readPhysicalPortFields, readPowerSupplyFields, type Document } from './model';
import { tiePorts } from './portTies';
import { SwapDoesNotFitError, planModelSwap, swapModel } from './swapModel';
import { undo } from './undo';

const ACTOR = '00000000000000000000000001';
let clock = 1_790_000_000_000;
const step = () => ({ actor: ACTOR, now: (clock += 1000) });

const port = (number: number | null, kind = 'RJ45', name?: string): CataloguePort => ({
  kind,
  number,
  ...(name ? { name } : {}),
  uplink: false,
  row: 'single',
  column: number ?? 0,
  groupGapBefore: false,
});

function model(name: string, rackUnits: number, ports: CataloguePort[], psuSlots: CatalogueModel['psuSlots'] = []): CatalogueModel {
  return {
    vendor: 'test',
    model: name,
    rackUnits,
    reviewedBy: 'reviewer',
    source: { cite: 'fixture', readOn: '2026-10-23' },
    psuSlots,
    faceplates: [{ face: 'front', portCount: ports.length, ports }],
  };
}

const at = { row: 'single' as const, column: 0 };
const OLD = model('OLD-4', 1, [port(1), port(2), port(3), port(4)], [{ name: 'PSU', hotSwap: false, face: 'rear', position: at }]);
const NEW = model('NEW-2C', 2, [port(1), port(2, 'SFP+'), port(null, 'RJ45', 'console')], [{ name: 'PSU', hotSwap: false, face: 'rear', position: at }]);
const PEER = model('PEER', 1, [port(1), port(2), port(3)]);
const CATALOGUE = [OLD, NEW, PEER];

interface Rig {
  doc: Document;
  rackId: string;
  box: string;
  peer: string;
  portOf: (chassis: string, label: string) => string;
}

function rig(): Rig {
  const premises = createPremises(emptyDocument(), step());
  let doc = createRack(premises.doc, premises.premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', ...step() });
  const rackId = doc.nodes.find((n) => n.id.startsWith('rack:'))!.id;
  doc = placeChassis(doc, rackId, OLD, 1, 'front', step());
  const box = edgesIn(doc, rackId, 'MountedIn')[0]!.from;
  doc = placeChassis(doc, rackId, PEER, 10, 'front', step());
  const peer = edgesIn(doc, rackId, 'MountedIn').find((e) => e.from !== box)!.from;
  const portOf = (chassis: string, label: string) =>
    edgesOut(doc, chassis, 'HasPort').map((e) => e.to).find((id) => readPhysicalPortFields(findNode(doc, id)!).label === label)!;
  return { doc, rackId, box, peer, portOf };
}

const live = (doc: Document, id: string) => findNode(doc, id)?.absentSince === undefined;
const portsOn = (doc: Document, chassis: string) =>
  edgesOut(doc, chassis, 'HasPort').map((e) => readPhysicalPortFields(findNode(doc, e.to)!).label).sort();

describe('swapping a device for another model, keeping its ports', () => {
  it('keeps same-named ports with their cables, leaves a dropped port’s cable loose, all in one undo step', () => {
    const r = rig();
    const p1 = r.portOf(r.box, '1');
    const p3 = r.portOf(r.box, '3');
    let doc = connectPorts(r.doc, p1, r.portOf(r.peer, '1'), {}, step());
    doc = connectPorts(doc, p3, r.portOf(r.peer, '3'), {}, step());
    doc = setChassisField(doc, r.box, 'serial', 'SN-OLD', step());
    const cable1 = edgesIn(doc, p1, 'Terminates')[0]!.from;
    const cable3 = edgesIn(doc, p3, 'Terminates')[0]!.from;

    const plan = planModelSwap(doc, r.box, NEW, CATALOGUE);
    expect(plan.kept.map((k) => k.label).sort()).toEqual(['1', '2', 'PSU']);
    expect(plan.added).toEqual(['console']);
    expect(plan.dropped.map((d) => [d.label, d.cableId])).toEqual([
      ['3', cable3],
      ['4', null],
    ]);
    expect(plan.height).toEqual({ from: 1, to: 2 });
    expect(plan.serial).toBe('SN-OLD');
    expect(swapSummary(plan)).toContain('Serial SN-OLD is cleared: a new box has its own.');

    const swapped = swapModel(doc, r.box, NEW, { catalogue: CATALOGUE, ...step() });
    expect(swapped.batches.length).toBe(doc.batches.length + 1);
    const chassis = readChassisFields(findNode(swapped, r.box)!);
    expect(chassis.model).toBe('NEW-2C');
    expect(chassis.serial).toBeUndefined();
    expect(readMountedInFields(edgesOut(swapped, r.box, 'MountedIn')[0]!).heightU).toBe(2);
    expect(portsOn(swapped, r.box)).toEqual(['1', '2', 'PSU', 'console']);

    // Port 1 is the same node, its cable untouched at both ends.
    expect(live(swapped, p1)).toBe(true);
    expect(edgesOut(swapped, cable1, 'Terminates')).toHaveLength(2);
    // Port 2 took the new model's connector.
    expect(readPhysicalPortFields(findNode(swapped, r.portOf(r.box, '2'))!).connector).toBe('sfp_plus');
    // Port 3 is gone; its cable stays, one end on the peer.
    expect(live(swapped, p3)).toBe(false);
    expect(live(swapped, cable3)).toBe(true);
    expect(edgesOut(swapped, cable3, 'Terminates').map((e) => e.to)).toEqual([r.portOf(r.peer, '3')]);

    const restored = undo(swapped, swapped.batches.at(-1)!.id, step());
    expect(readChassisFields(findNode(restored, r.box)!)).toMatchObject({ model: 'OLD-4', serial: 'SN-OLD' });
    expect(portsOn(restored, r.box)).toEqual(['1', '2', '3', '4', 'PSU']);
    expect(edgesOut(restored, cable3, 'Terminates')).toHaveLength(2);
    expect(readPhysicalPortFields(findNode(restored, r.portOf(r.box, '2'))!).connector).toBe('rj45');
    expect(readMountedInFields(edgesOut(restored, r.box, 'MountedIn')[0]!).heightU).toBe(1);
  });

  it('keeps an interface tie on a port that carries over, and drops one on a port that goes', () => {
    const r = rig();
    const p1 = r.portOf(r.box, '1');
    const p4 = r.portOf(r.box, '4');
    const device = edgesIn(r.doc, r.box, 'HasChassis')[0]!.from;
    const b = begin(r.doc, step());
    const ge0 = addNode(b, 'Interface', { 'Interface.name': interfaceName('ge-0/0/0'), 'Interface.form': token('ethernet') });
    const ge3 = addNode(b, 'Interface', { 'Interface.name': interfaceName('ge-0/0/3'), 'Interface.form': token('ethernet') });
    addEdge(b, 'HasInterface', device, ge0);
    addEdge(b, 'HasInterface', device, ge3);
    const doc = tiePorts(finish(b, 'paste'), device, [
      { interfaceId: ge0, portId: p1 },
      { interfaceId: ge3, portId: p4 },
    ], step());
    const swapped = swapModel(doc, r.box, NEW, { catalogue: CATALOGUE, ...step() });
    expect(edgesIn(swapped, p1, 'Occupies').map((e) => e.from)).toEqual([ge0]);
    expect(edgesOut(swapped, ge3, 'Occupies')).toHaveLength(0);
    expect(live(swapped, ge3)).toBe(true);
  });

  it('lands uplinks on the new model’s uplinks when the numbering moves, renaming them', () => {
    const SMALL = model('SW-4', 1, [port(1), port(2), port(3, 'SFP+'), port(4, 'SFP+')]);
    const BIG = model('SW-8', 1, [port(1), port(2), port(3), port(4), port(5), port(6), port(7, 'SFP+'), port(8, 'SFP+')]);
    const r = rig();
    let doc = placeChassis(r.doc, r.rackId, SMALL, 20, 'front', step());
    const box = edgesIn(doc, r.rackId, 'MountedIn').find((e) => e.from !== r.box && e.from !== r.peer)!.from;
    const sfp = edgesOut(doc, box, 'HasPort').map((e) => e.to).find((id) => readPhysicalPortFields(findNode(doc, id)!).label === '4')!;
    doc = connectOneEnd(doc, sfp, {}, step());
    const plan = planModelSwap(doc, box, BIG, CATALOGUE);
    expect(plan.kept.find((k) => k.portId === sfp)).toMatchObject({ label: '4', newLabel: '8', cabled: true });
    expect(plan.dropped).toEqual([]);
    expect(swapSummary(plan)).toContain("Renamed to the new model's numbering: 3 to 7, 4 to 8.");
    const swapped = swapModel(doc, box, BIG, step());
    expect(readPhysicalPortFields(findNode(swapped, sfp)!)).toMatchObject({ label: '8', connector: 'sfp_plus' });
    expect(edgesIn(swapped, sfp, 'Terminates')).toHaveLength(1);
    expect(portsOn(swapped, box)).toHaveLength(8);
  });

  it('refuses a taller model that would overlap the box above, writing nothing', () => {
    const r = rig();
    const doc = placeChassis(r.doc, r.rackId, PEER, 2, 'front', step());
    expect(() => swapModel(doc, r.box, NEW, step())).toThrow(SwapDoesNotFitError);
    expect(() => applyEditorChange(doc, { kind: 'swap-model', chassisId: r.box, model: { vendor: 'test', model: 'NEW-2C' } }, CATALOGUE, { actor: ACTOR })).toThrow(
      SwapDoesNotFitError,
    );
  });

  it('gives a hand-typed box a catalogue model, keeping its typed ports by name', () => {
    const made = addFreeBoxDoc(emptyDocument(), null, 0, 0, undefined, step());
    const doc = addSketchPortRange(made.doc, made.chassisId, { labelPrefix: '', first: 1, last: 3, connector: 'rj45', face: 'front' }, step());
    const before = edgesOut(doc, made.chassisId, 'HasPort').map((e) => e.to);
    const swapped = swapModel(doc, made.chassisId, PEER, step());
    expect(readChassisFields(findNode(swapped, made.chassisId)!).model).toBe('PEER');
    expect(edgesOut(swapped, made.chassisId, 'HasPort').map((e) => e.to).sort()).toEqual([...before].sort());
  });

  it('keeps a fitted hot-swap supply by slot, with the cable on its inlet', () => {
    const A = model('PSU-A', 1, [port(1)], [{ name: 'PSU 0', hotSwap: true, face: 'rear', position: at }, { name: 'PSU 1', hotSwap: true, face: 'rear', position: at }]);
    const B = model('PSU-B', 1, [port(1)], [{ name: 'PSU 0', hotSwap: true, face: 'rear', position: at }]);
    const r = rig();
    let doc = placeChassis(r.doc, r.rackId, A, 20, 'front', step());
    const box = edgesIn(doc, r.rackId, 'MountedIn').find((e) => e.from !== r.box && e.from !== r.peer)!.from;
    const slotOf = (id: string) => readPowerSupplyFields(findNode(doc, id)!).slot;
    const supplies = edgesOut(doc, box, 'FittedIn').map((e) => e.to).sort((x, y) => slotOf(x)!.localeCompare(slotOf(y)!));
    const inlet0 = edgesOut(doc, supplies[0]!, 'HasPort')[0]!.to;
    const inlet1 = edgesOut(doc, supplies[1]!, 'HasPort')[0]!.to;
    doc = connectOneEnd(doc, inlet0, {}, step());
    doc = connectOneEnd(doc, inlet1, {}, step());
    const gone = edgesIn(doc, inlet1, 'Terminates')[0]!.from;

    const swapped = swapModel(doc, box, B, { catalogue: [...CATALOGUE, A, B], ...step() });
    expect(edgesOut(swapped, box, 'FittedIn').map((e) => e.to)).toEqual([supplies[0]]);
    expect(live(swapped, inlet0)).toBe(true);
    expect(live(swapped, inlet1)).toBe(false);
    expect(edgesIn(swapped, inlet0, 'Terminates')).toHaveLength(1);
    // A cable whose only end was on the dropped inlet has nothing left to hold: it goes.
    expect(live(swapped, gone)).toBe(false);
  });

  it('says what the swap does before it is confirmed', () => {
    const r = rig();
    const doc = connectPorts(r.doc, r.portOf(r.box, '3'), r.portOf(r.peer, '3'), {}, step());
    const lines = swapSummary(planModelSwap(doc, r.box, NEW, CATALOGUE));
    expect(lines).toEqual([
      '3 ports carry over.',
      '1 new port.',
      'Not on the new model: 3. Its cable stays as a loose end in Missing links.',
      '1 empty port the new model lacks will go.',
      '1U becomes 2U, from the same bottom unit.',
      'One undo puts the old box back.',
    ]);
  });
});

