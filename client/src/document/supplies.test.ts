import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../api/catalogue';
import { connectToOutside } from './cables';
import { createRack, placeChassis, UnknownReferenceError } from './commands';
import { FieldValueError } from './edit';
import { edgesIn, edgesOut, emptyDocument, findNode, formatNodeId, readPowerSupplyFields, type Document } from './model';
import { FixedSlotError, fitSupply, removeSupply, SlotAlreadyFittedError, setSupplyField, UnknownSlotError } from './supplies';
import { newUlid } from './ulid';

const NOW = 1_700_000_000_000;

const MODEL_WITH_PSU: CatalogueModel = {
  vendor: 'juniper',
  model: 'EX4300-48P',
  rackUnits: 1,
  reviewedBy: 'reviewer',
  source: { cite: 'cite', readOn: '2026-09-14' },
  psuSlots: [
    { name: 'PSU0', hotSwap: true, face: 'rear', position: { row: 'single', column: 0 } },
    { name: 'PSU1', hotSwap: true, face: 'rear', position: { row: 'single', column: 1 } },
  ],
  faceplates: [
    { face: 'front', portCount: 1, ports: [{ kind: 'RJ45', number: 0, uplink: false, row: 'single', column: 0, groupGapBefore: false }] },
  ],
};

const MODEL_WITH_FIXED_PSU: CatalogueModel = {
  ...MODEL_WITH_PSU,
  psuSlots: [{ name: 'PSU0', hotSwap: false, face: 'rear', position: { row: 'single', column: 0 } }],
};

function docWithChassis(model: CatalogueModel): { doc: Document; chassisId: string; rackId: string } {
  const premisesId = formatNodeId('Premises', newUlid(NOW));
  const doc: Document = {
    ...emptyDocument(),
    nodes: [
      {
        id: premisesId,
        existence: newUlid(NOW),
        fields: { 'Premises.label': { presence: 'set', prov: newUlid(NOW), value: 'Riverside CO' } },
      },
    ],
  };
  const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', now: NOW });
  const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
  const placed = placeChassis(withRack, rackId, model, 12, 'front', { now: NOW });
  const mounted = edgesIn(placed, rackId, 'MountedIn')[0];
  return { doc: placed, chassisId: mounted.from, rackId };
}

function supplyIdFor(doc: Document, chassisId: string, slot: string): string {
  const edge = edgesOut(doc, chassisId, 'FittedIn').find(
    (e) => readPowerSupplyFields(findNode(doc, e.to)!).slot === slot,
  )!;
  return edge.to;
}

describe('removeSupply', () => {
  it('tombstones the supply, its inlet port and the FittedIn edge', () => {
    const { doc, chassisId } = docWithChassis(MODEL_WITH_PSU);
    const supplyId = supplyIdFor(doc, chassisId, 'PSU0');
    const inletEdge = edgesOut(doc, supplyId, 'HasPort')[0];

    const removed = removeSupply(doc, supplyId, { now: NOW });
    expect(findNode(removed, supplyId)!.absentSince).toBe(NOW);
    expect(findNode(removed, inletEdge.to)!.absentSince).toBe(NOW);
    expect(edgesIn(removed, supplyId, 'FittedIn')).toHaveLength(0);
    expect(edgesOut(removed, chassisId, 'FittedIn').filter((e) => e.to === supplyId)).toHaveLength(0);

    // The other slot is untouched.
    const otherSupplyId = supplyIdFor(doc, chassisId, 'PSU1');
    expect(findNode(removed, otherSupplyId)!.absentSince).toBeUndefined();
  });

  it('also disconnects a cable terminating at the inlet, through cables.ts’s disconnect', () => {
    const { doc, chassisId } = docWithChassis(MODEL_WITH_PSU);
    const supplyId = supplyIdFor(doc, chassisId, 'PSU0');
    const inletId = edgesOut(doc, supplyId, 'HasPort')[0].to;

    // `connectToOutside` needs no far-end connector to pair against
    // (`cables.ts`'s own doc) — simpler here than sourcing a compatible
    // `c13` PDU outlet just to prove `removeSupply` tombstones the cable.
    const cabled = connectToOutside(doc, inletId, { label: 'PDU 1' }, { now: NOW });
    const cableId = edgesIn(cabled, inletId, 'Terminates')[0].from;

    const removed = removeSupply(cabled, supplyId, { now: NOW });
    expect(findNode(removed, cableId)!.absentSince).toBe(NOW);
    expect(edgesOut(removed, cableId, 'Terminates').every((e) => e.absentSince === NOW)).toBe(true);
  });

  it('refuses an unknown supply', () => {
    const { doc } = docWithChassis(MODEL_WITH_PSU);
    expect(() => removeSupply(doc, 'power-supply:01ARZ3NDEKTSV4RRFFQ69G5FAV', { now: NOW })).toThrow(
      UnknownReferenceError,
    );
  });

  it('does not mutate its input', () => {
    const { doc, chassisId } = docWithChassis(MODEL_WITH_PSU);
    const supplyId = supplyIdFor(doc, chassisId, 'PSU0');
    const before = JSON.stringify(doc);
    removeSupply(doc, supplyId, { now: NOW });
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('fitSupply', () => {
  it('refits a slot removeSupply emptied', () => {
    const { doc, chassisId } = docWithChassis(MODEL_WITH_PSU);
    const supplyId = supplyIdFor(doc, chassisId, 'PSU0');
    const removed = removeSupply(doc, supplyId, { now: NOW });

    const refitted = fitSupply(removed, chassisId, 'PSU0', { serial: 'SN-1', model: 'PWR-750' }, { now: NOW + 1 });
    const newSupplyId = supplyIdFor(refitted, chassisId, 'PSU0');
    expect(newSupplyId).not.toBe(supplyId);
    expect(readPowerSupplyFields(findNode(refitted, newSupplyId)!)).toMatchObject({
      slot: 'PSU0',
      serial: 'SN-1',
      model: 'PWR-750',
    });
    const inlet = edgesOut(refitted, newSupplyId, 'HasPort')[0];
    expect(findNode(refitted, inlet.to)).toBeDefined();
  });

  it('refuses an unknown slot', () => {
    const { doc, chassisId } = docWithChassis(MODEL_WITH_PSU);
    expect(() => fitSupply(doc, chassisId, 'PSU9', {}, { now: NOW })).toThrow(UnknownSlotError);
  });

  it('refuses a slot already fitted', () => {
    const { doc, chassisId } = docWithChassis(MODEL_WITH_PSU);
    expect(() => fitSupply(doc, chassisId, 'PSU0', {}, { now: NOW })).toThrow(SlotAlreadyFittedError);
  });

  it('refuses a fixed slot', () => {
    const { doc, chassisId } = docWithChassis(MODEL_WITH_FIXED_PSU);
    expect(() => fitSupply(doc, chassisId, 'PSU0', {}, { now: NOW })).toThrow(FixedSlotError);
  });

  it('refuses an unknown chassis', () => {
    const { doc } = docWithChassis(MODEL_WITH_PSU);
    expect(() => fitSupply(doc, 'chassis:01ARZ3NDEKTSV4RRFFQ69G5FAV', 'PSU0', {}, { now: NOW })).toThrow(
      UnknownReferenceError,
    );
  });
});

describe('setSupplyField', () => {
  it('sets serial and model as one Origin::Hand batch each', () => {
    const { doc, chassisId } = docWithChassis(MODEL_WITH_PSU);
    const supplyId = supplyIdFor(doc, chassisId, 'PSU0');
    const withSerial = setSupplyField(doc, supplyId, 'serial', 'SN-42', { now: NOW });
    expect(readPowerSupplyFields(findNode(withSerial, supplyId)!).serial).toBe('SN-42');
    const withModel = setSupplyField(withSerial, supplyId, 'model', 'PWR-750', { now: NOW + 1 });
    expect(readPowerSupplyFields(findNode(withModel, supplyId)!).model).toBe('PWR-750');
  });

  it('clears as absent', () => {
    const { doc, chassisId } = docWithChassis(MODEL_WITH_PSU);
    const supplyId = supplyIdFor(doc, chassisId, 'PSU0');
    const once = setSupplyField(doc, supplyId, 'serial', 'SN-42', { now: NOW });
    const cleared = setSupplyField(once, supplyId, 'serial', null, { now: NOW + 1 });
    expect(findNode(cleared, supplyId)!.fields['PowerSupply.serial'].presence).toBe('absent');
  });

  it('refuses a serial with a space (not a valid Identifier)', () => {
    const { doc, chassisId } = docWithChassis(MODEL_WITH_PSU);
    const supplyId = supplyIdFor(doc, chassisId, 'PSU0');
    expect(() => setSupplyField(doc, supplyId, 'serial', 'has space', { now: NOW })).toThrow(FieldValueError);
  });

  it('refuses an unknown supply', () => {
    const { doc } = docWithChassis(MODEL_WITH_PSU);
    expect(() =>
      setSupplyField(doc, 'power-supply:01ARZ3NDEKTSV4RRFFQ69G5FAV', 'serial', 'SN-1', { now: NOW }),
    ).toThrow(UnknownReferenceError);
  });
});
