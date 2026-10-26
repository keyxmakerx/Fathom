import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../api/catalogue';
import { connectOneEnd } from './cables';
import { cardOfPort, cardsOf, CageTakenError, chassisOfCard, fitCard, moveOptic, opticOf, removeCard, setCardField, setOptic, slotPath, SlotTakenByCardError } from './cards';
import { createRack, placeChassis } from './commands';
import { FieldValueError } from './edit';
import { edgesIn, edgesOut, emptyDocument, findNode, formatNodeId, readPhysicalPortFields, type Document } from './model';
import { newUlid } from './ulid';

const NOW = 1_700_000_000_000;

const CHASSIS_MODEL: CatalogueModel = {
  vendor: 'juniper',
  model: 'EX4300-48P',
  rackUnits: 1,
  reviewedBy: 'reviewer',
  source: { cite: 'cite', readOn: '2026-09-14' },
  psuSlots: [],
  faceplates: [{ face: 'front', portCount: 1, ports: [{ kind: 'RJ45', number: 0, uplink: false, row: 'single', column: 0, groupGapBefore: false }] }],
};

function docWithChassis(): { doc: Document; chassisId: string } {
  const premisesId = formatNodeId('Premises', newUlid(NOW));
  const doc: Document = {
    ...emptyDocument(),
    nodes: [{ id: premisesId, existence: newUlid(NOW), fields: { 'Premises.label': { presence: 'set', prov: newUlid(NOW), value: 'HQ' } } }],
  };
  const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', now: NOW });
  const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
  const placed = placeChassis(withRack, rackId, CHASSIS_MODEL, 12, 'front', { now: NOW });
  return { doc: placed, chassisId: edgesIn(placed, rackId, 'MountedIn')[0].from };
}

const portByLabel = (doc: Document, chassisId: string, label: string): string =>
  edgesOut(doc, chassisId, 'HasPort').find((e) => readPhysicalPortFields(findNode(doc, e.to)!).label === label)!.to;

describe('cards', () => {
  it('fits a card with its ports, owned by the chassis and pointing at the card', () => {
    const { doc, chassisId } = docWithChassis();
    const next = fitCard(doc, chassisId, '1', { name: '4 x QSFP28', model: 'LC-4QSFP28', serial: 'FJZ1', ports: { prefix: '1/', first: 1, last: 4, connector: 'qsfp28' } });
    const [card] = cardsOf(next, chassisId);
    expect(card).toMatchObject({ slot: '1', name: '4 x QSFP28', model: 'LC-4QSFP28', serial: 'FJZ1' });
    expect(card.portIds).toHaveLength(4);
    const p = portByLabel(next, chassisId, '1/3');
    expect(cardOfPort(next, p)).toBe(card.id);
    expect(chassisOfCard(next, card.id)).toBe(chassisId);
    expect(next.batches.at(-1)!.label).toBe('fit card in slot 1');
  });

  it('refuses a taken slot and a clashing port label', () => {
    const { doc, chassisId } = docWithChassis();
    const one = fitCard(doc, chassisId, '1', { ports: { prefix: '1/', first: 1, last: 2, connector: 'sfp_plus' } });
    expect(() => fitCard(one, chassisId, '1')).toThrow(SlotTakenByCardError);
    expect(() => fitCard(one, chassisId, '2', { ports: { prefix: '1/', first: 2, last: 3, connector: 'sfp_plus' } })).toThrow(FieldValueError);
    expect(() => fitCard(one, chassisId, '2', { model: 'has space' })).toThrow(FieldValueError);
  });

  it('seats a card in a sub-slot and names the path', () => {
    const { doc, chassisId } = docWithChassis();
    const mpc = fitCard(doc, chassisId, 'FPC 2', { name: 'MPC' });
    const mpcId = cardsOf(mpc, chassisId)[0].id;
    const mic = fitCard(mpc, mpcId, '0', { name: 'MIC', ports: { prefix: '2/0/', first: 0, last: 1, connector: 'sfp_plus' } });
    const micId = cardsOf(mic, mpcId)[0].id;
    expect(chassisOfCard(mic, micId)).toBe(chassisId);
    expect(slotPath(mic, micId)).toBe('slot FPC 2 · sub-slot 0');
    expect(edgesOut(mic, chassisId, 'HasPort').length).toBe(3);
  });

  it('takes a card out with its sub-cards and ports, and leaves a plugged cable loose', () => {
    const { doc, chassisId } = docWithChassis();
    const a = fitCard(doc, chassisId, 'FPC 0', { ports: { prefix: '0/', first: 0, last: 1, connector: 'sfp_plus' } });
    const cardId = cardsOf(a, chassisId)[0].id;
    const b = fitCard(a, cardId, '0', { ports: { prefix: '0/0/', first: 0, last: 0, connector: 'sfp_plus' } });
    const port = portByLabel(b, chassisId, '0/1');
    const cabled = connectOneEnd(b, port);
    const cableId = edgesIn(cabled, port, 'Terminates')[0].from;
    const out = removeCard(cabled, cardId);
    expect(cardsOf(out, chassisId)).toEqual([]);
    expect(edgesOut(out, chassisId, 'HasPort').length).toBe(1);
    expect(findNode(out, cableId)!.absentSince).toBeUndefined();
    expect(out.batches.at(-1)!.label).toBe('take out card');
  });

  it('edits and clears a card field', () => {
    const { doc, chassisId } = docWithChassis();
    const a = fitCard(doc, chassisId, '0');
    const id = cardsOf(a, chassisId)[0].id;
    const b = setCardField(a, id, 'serial', 'ABC123');
    expect(cardsOf(b, chassisId)[0].serial).toBe('ABC123');
    const c = setCardField(b, id, 'serial', null);
    expect(cardsOf(c, chassisId)[0].serial).toBeNull();
    expect(c.history.length).toBeGreaterThan(0);
  });
});

describe('optics', () => {
  it('reads nobody-looked, empty and fitted apart', () => {
    const { doc, chassisId } = docWithChassis();
    const a = fitCard(doc, chassisId, '0', { ports: { prefix: '0/', first: 1, last: 2, connector: 'sfp_plus' } });
    const p1 = portByLabel(a, chassisId, '0/1');
    expect(opticOf(findNode(a, p1)!)).toBeUndefined();
    const empty = setOptic(a, p1, null);
    expect(opticOf(findNode(empty, p1)!)).toBeNull();
    const fitted = setOptic(empty, p1, { type: '10GBASE-SR', part: 'SFP-10G-SR', serial: 'X1', wavelengthNm: 850 });
    expect(opticOf(findNode(fitted, p1)!)).toEqual({ type: '10GBASE-SR', part: 'SFP-10G-SR', serial: 'X1', wavelengthNm: 850 });
    expect(findNode(fitted, p1)!.fields['PhysicalPort.transceiver'].value).toEqual({ part: 'SFP-10G-SR', serial: 'X1', type: '10GBASE-SR', wavelength_nm: 850 });
    expect(opticOf(findNode(setOptic(a, p1, {}), p1)!)).toEqual({});
  });

  it('moves an optic to another cage in one undo, and refuses a full cage', () => {
    const { doc, chassisId } = docWithChassis();
    const a = fitCard(doc, chassisId, '0', { ports: { prefix: '0/', first: 1, last: 3, connector: 'sfp_plus' } });
    const [p1, p2, p3] = ['0/1', '0/2', '0/3'].map((l) => portByLabel(a, chassisId, l));
    const b = setOptic(setOptic(a, p1, { part: 'SFP-10G-LR' }), p3, {});
    const moved = moveOptic(b, p1, p2);
    expect(opticOf(findNode(moved, p2)!)).toEqual({ part: 'SFP-10G-LR' });
    expect(opticOf(findNode(moved, p1)!)).toBeNull();
    expect(moved.batches.at(-1)!.ops).toHaveLength(2);
    expect(() => moveOptic(moved, p2, p3)).toThrow(CageTakenError);
  });

  it('refuses a part number with a space and a wavelength out of range', () => {
    const { doc, chassisId } = docWithChassis();
    const a = fitCard(doc, chassisId, '0', { ports: { prefix: '0/', first: 1, last: 1, connector: 'sfp_plus' } });
    const p = portByLabel(a, chassisId, '0/1');
    expect(() => setOptic(a, p, { part: 'SFP 10G' })).toThrow(FieldValueError);
    expect(() => setOptic(a, p, { wavelengthNm: 70000 })).toThrow(FieldValueError);
  });
});
