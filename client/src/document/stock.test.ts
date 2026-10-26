import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../api/catalogue';
import { cardsOf, fitCard, opticOf, setOptic } from './cards';
import { createRack, placeChassis } from './commands';
import { readFacts } from './facts';
import { edgesIn, edgesOut, emptyDocument, findNode, formatNodeId, readPhysicalPortFields, type Document } from './model';
import { readPlain, writePlain } from './plain';
import {
  StockRefusal,
  addStock,
  addStore,
  backToSpare,
  belowMinimum,
  cleanDue,
  guessPart,
  lend,
  listStock,
  readStockRows,
  removeStore,
  reserve,
  reservedFor,
  retire,
  sendToRepair,
  setStockLevel,
  sparesFor,
  stockForIssue,
  stockFromFacts,
  stockFromFitted,
  stockItem,
  stockLevels,
  takeOutToStock,
  storeView,
  swapFromStock,
  takeFromStock,
} from './stock';
import { createIssue, TYPED_AS_WRITTEN as gate } from './issues';
import { addStep, createPlan } from './plans';
import { undo } from './undo';
import { newUlid } from './ulid';

const NOW = 1_700_000_000_000;
const by = { actor: '01ARZ3NDEKTSV4RRFFQ69G5FAV' };

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

function cupboard() {
  const { doc, chassisId } = docWithChassis();
  const store = addStore(doc, { name: 'Comms cupboard', place: '2nd floor' }, { ...by, now: NOW + 10 });
  const added = addStock(
    store.doc,
    [
      { part: 'optic', model: 'SFP-10G-SR', serial: 'AVP1001', storeId: store.id, bin: 'bin 3', optic: { type: '10GBASE-SR', wavelengthNm: 850 } },
      { part: 'optic', model: 'SFP-10G-SR', serial: 'AVP1002', storeId: store.id, bin: 'bin 3' },
      { part: 'cable', name: 'Patch lead, Cat6, 2 m, blue', count: 37, storeId: store.id },
      { part: 'card', model: 'LC-4QSFP28', serial: 'FJZ9', state: 'on_order', due: '2026-11-04' },
    ],
    { ...by, now: NOW + 20 },
  );
  return { doc: added.doc, ids: added.ids, storeId: store.id, chassisId, base: doc };
}

describe('stock', () => {
  it('adds a list to a store as one undo step, and reads it back bin by bin', () => {
    const { doc, storeId, base } = cupboard();
    expect(doc.batches.length).toBe(base.batches.length + 2);
    expect(doc.batches.at(-1)!.label).toBe('add 4 to stock');
    const page = storeView(doc, storeId)!;
    expect(page.store).toMatchObject({ name: 'Comms cupboard', place: '2nd floor' });
    expect(page.bins.map((b) => [b.bin, b.items.length])).toEqual([
      [null, 1],
      ['bin 3', 2],
    ]);
    expect(page.onHand).toBe(39);
    const [sr] = listStock(doc, { parts: ['optic'] });
    expect(sr.optic).toEqual({ type: '10GBASE-SR', wavelengthNm: 850 });
    const back = undo(doc, doc.batches.at(-1)!.id, { ...by, now: NOW + 30 });
    expect(listStock(back)).toEqual([]);
  });

  it('refuses a serial already in stock, a serial with a count, and a model with a space', () => {
    const { doc } = cupboard();
    expect(() => addStock(doc, { part: 'optic', serial: 'AVP1001' })).toThrow('AVP1001 is in stock already.');
    expect(() => addStock(doc, [{ part: 'optic', serial: 'X1' }, { part: 'optic', serial: 'X1' }])).toThrow(StockRefusal);
    expect(() => addStock(doc, { part: 'optic', serial: 'X2', count: 3 })).toThrow(StockRefusal);
    expect(() => addStock(doc, { part: 'card', model: 'has space' })).toThrow('one word');
    expect(() => addStock(doc, { part: 'card', due: '2026-02-30' })).toThrow('not a date');
  });

  it('keeps a stock level and says when a model runs short, counting only spares', () => {
    const { doc } = cupboard();
    const levelled = setStockLevel(setStockLevel(doc, 'SFP-10G-SR', 3, by), 'LC-4QSFP28', 1, by);
    expect(stockLevels(levelled).map((l) => [l.model, l.atLeast, l.have, l.onOrder])).toEqual([
      ['LC-4QSFP28', 1, 0, 1],
      ['SFP-10G-SR', 3, 2, 0],
    ]);
    expect(belowMinimum(levelled).map((l) => l.model)).toEqual(['LC-4QSFP28', 'SFP-10G-SR']);
    const again = setStockLevel(levelled, 'SFP-10G-SR', 2, by);
    expect(stockLevels(again).filter((l) => l.model === 'SFP-10G-SR')).toHaveLength(1);
    expect(belowMinimum(again).map((l) => l.model)).toEqual(['LC-4QSFP28']);
    expect(stockLevels(setStockLevel(again, 'SFP-10G-SR', 0, by)).map((l) => l.model)).toEqual(['LC-4QSFP28']);
  });

  it('reserves a spare for a plan step, and a counted item splits', () => {
    const { doc, ids } = cupboard();
    const plan = createPlan(doc, { title: 'Swap the dead optic', gate, ...by });
    const step = addStep(plan.doc, plan.id, { kind: 'swap', change: 'Swap the optic in 0/1', gate, ...by });
    const kept = reserve(step.doc, ids[0], step.id, by);
    expect(reservedFor(kept, step.id)?.serial).toBe('AVP1001');
    expect(stockItem(kept, ids[0])!.state).toBe('reserved');
    const leads = reserve(kept, ids[2], step.id, { ...by, count: 2 });
    const cables = listStock(leads, { parts: ['cable'] });
    expect(cables.map((c) => [c.count, c.state]).sort()).toEqual([
      [2, 'reserved'],
      [35, 'spare'],
    ]);
    expect(() => reserve(kept, ids[3], step.id, by)).toThrow('Only a spare can be reserved');
  });

  it('sends an item for repair against an issue, lends one, and brings both back', () => {
    const { doc, ids } = cupboard();
    const deviceId = doc.nodes.find((n) => n.id.startsWith('device:'))!.id;
    const issue = createIssue(doc, { deviceId, title: 'Uplink down', steps: [{ topic: 'link', question: 'Is the link light on?', answer: 'not_ok' }], gate, ...by });
    const away = sendToRepair(issue.doc, ids[0], { rma: 'RMA-7745', due: '2026-11-20', issueId: issue.id }, by);
    expect(stockItem(away, ids[0])).toMatchObject({ state: 'in_repair', rma: 'RMA-7745', due: '2026-11-20', forIssue: issue.id });
    expect(stockForIssue(away, issue.id).map((i) => i.id)).toEqual([ids[0]]);
    const lent = lend(away, ids[1], { to: 'Sam at the lab', due: '2026-11-01' }, by);
    expect(stockItem(lent, ids[1])).toMatchObject({ state: 'lent', lentTo: 'Sam at the lab' });
    const home = backToSpare(backToSpare(lent, ids[0], by), ids[1], by);
    expect(stockItem(home, ids[0])).toMatchObject({ state: 'spare', rma: null, due: null, forIssue: null });
    expect(stockItem(home, ids[1])).toMatchObject({ state: 'spare', lentTo: null, due: null });
  });

  it('uses leads from a count, and retires a dead part without losing its serial', () => {
    const { doc, ids } = cupboard();
    const used = takeFromStock(doc, ids[2], 5, by);
    expect(stockItem(used, ids[2])!.count).toBe(32);
    expect(() => takeFromStock(used, ids[2], 40, by)).toThrow('only 32');
    expect(stockItem(takeFromStock(used, ids[2], 32, by), ids[2])).toBeNull();
    const dead = retire(doc, ids[0], by);
    expect(listStock(dead, { states: ['retired'] }).map((i) => i.serial)).toEqual(['AVP1001']);
    expect(storeView(dead, cupboardStore(dead))!.bins.flatMap((b) => b.items).some((i) => i.id === ids[0])).toBe(false);
  });

  it('swaps an optic from stock: the cage takes the spare, the old one goes to repair remembering where it was', () => {
    const { doc, ids, chassisId } = cupboard();
    const port = portByLabel(doc, chassisId, '0');
    const fitted = setOptic(doc, port, { type: '10GBASE-SR', part: 'SFP-10G-SR', serial: 'DEAD01' }, by);
    expect(sparesFor(fitted, port).map((i) => i.serial)).toEqual(['AVP1001', 'AVP1002']);
    const from = fitted.batches.length;
    const swapped = swapFromStock(fitted, port, ids[0], { ...by, oldTo: 'in_repair', rma: 'RMA-1' });
    expect(swapped.batches.length).toBe(from + 1);
    expect(swapped.batches.at(-1)!.label).toBe('swap part from stock');
    expect(opticOf(findNode(swapped, port)!)).toEqual({ part: 'SFP-10G-SR', serial: 'AVP1001', type: '10GBASE-SR', wavelengthNm: 850 });
    expect(stockItem(swapped, ids[0])).toBeNull();
    const [old] = listStock(swapped, { states: ['in_repair'] });
    expect(old).toMatchObject({ part: 'optic', serial: 'DEAD01', rma: 'RMA-1', cameFrom: '0' });
    expect(old.storeId).not.toBeNull();
    const back = undo(swapped, swapped.batches.at(-1)!.id, { ...by, now: NOW + 99 });
    expect(opticOf(findNode(back, port)!)?.serial).toBe('DEAD01');
    expect(listStock(back, { states: ['in_repair'] })).toEqual([]);
  });

  it('swaps a card from stock and refuses a spare of the wrong sort', () => {
    const { doc, ids, chassisId } = cupboard();
    const withCard = fitCard(doc, chassisId, '1', { model: 'LC-4QSFP28', serial: 'OLD1' });
    const cardId = cardsOf(withCard, chassisId)[0].id;
    expect(() => swapFromStock(withCard, cardId, ids[0], { ...by, oldTo: 'spare' })).toThrow('That is a optic');
    expect(() => swapFromStock(withCard, cardId, ids[3], { ...by, oldTo: 'spare' })).toThrow('on order');
    const arrived = backToSpare(withCard, ids[3], by);
    const swapped = swapFromStock(arrived, cardId, ids[3], { ...by, oldTo: 'gone' });
    expect(cardsOf(swapped, chassisId)[0]).toMatchObject({ model: 'LC-4QSFP28', serial: 'FJZ9' });
    expect(listStock(swapped, { parts: ['card'] })).toEqual([]);
    const kept = stockFromFitted(swapped, cardId, 'spare', by);
    expect(stockItem(kept.doc, kept.id)).toMatchObject({ part: 'card', serial: 'FJZ9', cameFrom: 'slot 1' });
  });

  it('takes a card out of the drawing into stock as one undo step', () => {
    const { doc, chassisId, storeId } = cupboard();
    const withCard = fitCard(doc, chassisId, '2', { model: 'LC-8SFP', serial: 'CARD7' });
    const cardId = cardsOf(withCard, chassisId)[0].id;
    const from = withCard.batches.length;
    const out = takeOutToStock(withCard, cardId, 'spare', { ...by, storeId, bin: 'shelf 1' });
    expect(out.doc.batches.length).toBe(from + 1);
    expect(cardsOf(out.doc, chassisId)).toEqual([]);
    expect(stockItem(out.doc, out.id)).toMatchObject({ part: 'card', serial: 'CARD7', cameFrom: 'slot 2', storeId, bin: 'shelf 1', state: 'spare' });
  });

  it('removes a store and keeps what was in it', () => {
    const { doc, storeId } = cupboard();
    const gone = removeStore(doc, storeId, by);
    expect(listStock(gone)).toHaveLength(4);
    expect(listStock(gone).every((i) => i.storeId === null)).toBe(true);
  });

  it('survives the plain file', () => {
    const { doc } = cupboard();
    const withLevel = setStockLevel(doc, 'SFP-10G-SR', 3, by);
    const again = readPlain(writePlain(withLevel));
    expect(listStock(again)).toEqual(listStock(withLevel));
    expect(stockLevels(again)).toEqual(stockLevels(withLevel));
  });
});

function cupboardStore(doc: Document): string {
  return doc.nodes.find((n) => n.id.startsWith('store:') && n.absentSince === undefined)!.id;
}

describe('reading a list or a file into stock', () => {
  it('reads a CSV with a header, guessing the sort and naming the columns it left for custom fields', () => {
    const csv = 'Model,Serial,Qty,Bin,Price,Supplier,Description\nSFP-10G-SR,AVP1,,bin 3,£40,Acme,\nPWR-C6-1KWAC,,2,,£300,Acme,\n,,37,,,,"Patch lead, 2 m"\n';
    const { rows, skipped } = readStockRows(csv);
    expect(rows.map((r) => [r.part, r.model, r.serial, r.count, r.bin])).toEqual([
      ['optic', 'SFP-10G-SR', 'AVP1', undefined, 'bin 3'],
      ['power_supply', 'PWR-C6-1KWAC', undefined, 2, undefined],
      ['cable', undefined, undefined, 37, undefined],
    ]);
    expect(skipped[0].why).toContain('price, supplier');
  });

  it('refuses a model with a space, line by line, and reads a bare list of model and serial', () => {
    const { rows } = readStockRows('SFP-10G-SR AVP1\nSFP-10G-LR AVP2 spare from the old core\n');
    expect(rows.map((r) => [r.part, r.model, r.serial, r.name])).toEqual([
      ['optic', 'SFP-10G-SR', 'AVP1', undefined],
      ['optic', 'SFP-10G-LR', 'AVP2', 'spare from the old core'],
    ]);
    expect(readStockRows('model,serial\nhas space,X\n').skipped).toEqual([{ line: 2, why: 'the model "has space" has a space in it' }]);
  });

  it("turns a device's own inventory into stock rows", () => {
    const facts = readFacts(
      'NAME: "Te1/1/1", DESCR: "10Gbase-SR SFP Module"\nPID: SFP-10G-SR , VID: V02 , SN: AVP19230XYZ\nNAME: "Switch 1 - Power Supply A", DESCR: "Power Supply"\nPID: PWR-C6-1KWAC , VID: V01 , SN: LIT1\n',
    );
    const rows = stockFromFacts(facts!);
    expect(rows.map((r) => [r.part, r.model, r.serial])).toEqual(
      expect.arrayContaining([
        ['optic', 'SFP-10G-SR', 'AVP19230XYZ'],
        ['power_supply', 'PWR-C6-1KWAC', 'LIT1'],
      ]),
    );
  });

  it('guesses a sort from a model, and reads a due date only as a date', () => {
    expect(guessPart('QSFP-100G-LR4')).toBe('optic');
    expect(guessPart('PWR-C1-350WAC')).toBe('power_supply');
    expect(guessPart('EX4300-48P')).toBe('other');
    expect(cleanDue('2026-11-04')).toBe('2026-11-04');
    expect(() => cleanDue('next week')).toThrow(StockRefusal);
  });
});
