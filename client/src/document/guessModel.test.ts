import { describe, expect, it } from 'vitest';

import type { CatalogueModel, CataloguePort } from '../api/catalogue';
import { addFreeBoxDoc } from '../components/racks/freeActions';
import { connectPorts } from './cables';
import { addSketchPort, addSketchPortRange } from './commands';
import { guessModel } from './guessModel';
import { edgesIn, edgesOut, emptyDocument, findNode, readChassisFields, readPhysicalPortFields, type Document } from './model';
import { addNote } from './notes';
import { portNumberOf, swapModel } from './swapModel';

const ACTOR = '00000000000000000000000001';
let clock = 1_790_000_000_000;
const step = () => ({ actor: ACTOR, now: (clock += 1000) });

const sfp = (number: number): CataloguePort => ({ kind: 'SFP+', number, uplink: number > 48, row: 'single', column: number, groupGapBefore: false });

function arista(model: string, count: number): CatalogueModel {
  return {
    vendor: 'arista',
    model,
    rackUnits: 1,
    reviewedBy: 'reviewer',
    source: { cite: 'fixture', readOn: '2026-10-31' },
    psuSlots: [],
    faceplates: [{ face: 'front', portCount: count, ports: Array.from({ length: count }, (_, i) => sfp(i + 1)) }],
  };
}

const S52 = arista('DCS-7050S-52', 52);
const SX3 = arista('DCS-7050SX3-48YC8', 56);
const PEER = { ...arista('PEER-4', 4), vendor: 'test' };
const CATALOGUE = [S52, SX3, PEER];

/** A hand-typed switch with Et3, Et49 and Et51 cabled to a peer, the shape of the owner's "sweetch". */
function sweetch(note?: string): { doc: Document; box: string; ports: Record<string, string> } {
  const made = addFreeBoxDoc(emptyDocument(), null, 0, 0, undefined, step());
  let doc = made.doc;
  for (const label of ['Et3', 'Et49', 'Et51']) doc = addSketchPort(doc, made.chassisId, { label, connector: 'sfp_plus', face: 'front' }, step());
  const peer = addFreeBoxDoc(doc, null, 400, 0, undefined, step(), PEER);
  doc = peer.doc;
  const portOf = (chassis: string, label: string) =>
    edgesOut(doc, chassis, 'HasPort').map((e) => e.to).find((id) => readPhysicalPortFields(findNode(doc, id)!).label === label)!;
  const ports = { Et3: portOf(made.chassisId, 'Et3'), Et49: portOf(made.chassisId, 'Et49'), Et51: portOf(made.chassisId, 'Et51') };
  doc = connectPorts(doc, ports.Et49, portOf(peer.chassisId, '1'), { label: 'Arista Et49 to Painite' }, step());
  doc = connectPorts(doc, ports.Et51, portOf(peer.chassisId, '2'), {}, step());
  if (note) doc = addNote(doc, edgesIn(doc, made.chassisId, 'HasChassis')[0]!.from, { text: note, how: 'typed', ...step() });
  return { doc, box: made.chassisId, ports };
}

describe('guessing the catalogue model of a box typed by hand', () => {
  it('reads a number out of a typed port name, and nothing out of a plain number or a path', () => {
    expect(portNumberOf('Et49')).toBe('49');
    expect(portNumberOf('Ethernet 7')).toBe('7');
    expect(portNumberOf('port-03')).toBe('3');
    expect(portNumberOf('49')).toBeNull();
    expect(portNumberOf('Gi1/0/49')).toBeNull();
    expect(portNumberOf('Uplink to Arista')).toBeNull();
  });

  it('picks the model the device’s note names, and says why', () => {
    const r = sweetch('Arista DCS-7050S-52 (48x SFP+ and 4x SFP+, 1U), hostname Sweetch.');
    const guess = guessModel(r.doc, r.box, CATALOGUE)!;
    expect(guess).toMatchObject({ vendor: 'arista', model: 'DCS-7050S-52' });
    expect(guess.why[0]).toBe('Its notes name the DCS-7050S-52.');
    expect(guess.why).toContain('All 3 typed ports carry over, with their cables.');
    expect(guess.plan.dropped).toEqual([]);
  });

  it('offers nothing on a vendor hint alone when two models fit as well', () => {
    const r = sweetch();
    expect(guessModel(r.doc, r.box, CATALOGUE)).toBeNull();
  });

  it('offers nothing for a box that already has a model', () => {
    const r = sweetch('DCS-7050S-52');
    const swapped = swapModel(r.doc, r.box, S52, { catalogue: CATALOGUE, ...step() });
    expect(guessModel(swapped, r.box, CATALOGUE)).toBeNull();
  });

  it('swapping to the guess keeps Et49 and Et51 as ports 49 and 51, cables and all', () => {
    const r = sweetch('Arista DCS-7050S-52');
    const cable49 = edgesIn(r.doc, r.ports.Et49, 'Terminates')[0]!.from;
    const swapped = swapModel(r.doc, r.box, S52, { catalogue: CATALOGUE, ...step() });
    expect(readChassisFields(findNode(swapped, r.box)!).model).toBe('DCS-7050S-52');
    expect(readPhysicalPortFields(findNode(swapped, r.ports.Et49)!)).toMatchObject({ label: '49', connector: 'sfp_plus' });
    expect(readPhysicalPortFields(findNode(swapped, r.ports.Et51)!).label).toBe('51');
    expect(readPhysicalPortFields(findNode(swapped, r.ports.Et3)!).label).toBe('3');
    expect(edgesIn(swapped, r.ports.Et49, 'Terminates').map((e) => e.from)).toEqual([cable49]);
    expect(edgesOut(swapped, r.box, 'HasPort')).toHaveLength(52);
  });

  it('keeps typed ranges like "Et1".."Et4" when the box has no note at all', () => {
    const made = addFreeBoxDoc(emptyDocument(), null, 0, 0, undefined, step());
    const doc = addSketchPortRange(made.doc, made.chassisId, { labelPrefix: 'Et', first: 1, last: 4, connector: 'rj45', face: 'front' }, step());
    const swapped = swapModel(doc, made.chassisId, S52, { catalogue: CATALOGUE, ...step() });
    expect(edgesOut(swapped, made.chassisId, 'HasPort')).toHaveLength(52);
  });
});
