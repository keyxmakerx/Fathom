// Spares and stores (ADR-0076, schema 0.30, sign-offs r36-stock and r38-stock-how). A `StockItem` is
// something on hand but not fitted: a spare card, optic, power supply, device or lead, or one on order,
// away for repair, lent out or retired. A `Store` is where spares are kept that is not a rack; an item
// names its store (`InStore`) and its bin in words. A `StockLevel` is the fewest spares of one model to
// keep. All three hang off the root with no edge, as a Tag does.
//
// Fitting a spare is the existing swap (`plans.ts` `swapPart`): the fitted Card, PowerSupply or optic
// takes the spare's model and serial, the spare's item ends, and the part that came out becomes an
// item with where it was fitted frozen in `came_from`. So the serial's history reads on from the
// design's own change history, and nothing new learns how to fit a card.
//
// A serial is inventory and never leaves the workspace (Chassis.serial's rule). Prices and suppliers
// are custom fields on the item (r38: "A custom fields"), not fields here. All pure, one undoable
// batch per call, `Origin::Hand`.

import { encodeOptic, opticOf, removeCard, setCardField, setOptic, chassisOfCard, slotPath, type Optic } from './cards';
import { addEdge, addNode, begin, finish, foldFrom, setNodeField, tombstone, type Build } from './freeform';
import {
  archiveField,
  assertHand,
  asNumber,
  asString,
  edgesIn,
  edgesOut,
  fieldValue,
  findNode,
  identifier,
  kebab,
  parseNodeId,
  readPhysicalPortFields,
  readPowerSupplyFields,
  replaceNode,
  requireFieldName,
  text,
  token,
  uint,
  type Document,
  type FieldEntry,
  type GraphNode,
} from './model';
import type { DeviceFacts } from './facts';
import { removeSupply, setSupplyField } from './supplies';

interface Actor {
  actor?: string;
  now?: number;
}

export class StockRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StockRefusal';
  }
}

export const STOCK_PARTS = ['card', 'optic', 'power_supply', 'device', 'cable', 'other'] as const;
export type StockPart = (typeof STOCK_PARTS)[number];

export const PART_LABEL: Record<StockPart, string> = {
  card: 'Card',
  optic: 'Optic',
  power_supply: 'Power supply',
  device: 'Device',
  cable: 'Cable or lead',
  other: 'Other',
};

export const STOCK_STATES = ['spare', 'reserved', 'on_order', 'in_repair', 'lent', 'retired'] as const;
export type StockState = (typeof STOCK_STATES)[number];

export const STATE_LABEL: Record<StockState, string> = {
  spare: 'Spare',
  reserved: 'Reserved',
  on_order: 'On order',
  in_repair: 'Away for repair',
  lent: 'Lent out',
  retired: 'Retired',
};

export const MAX_NAME = 120;
export const MAX_NOTE = 500;
export const MAX_WORDS = 120;
/** One paste or file adds at most this many rows; a bigger list is a sign the wrong thing was pasted. */
export const MAX_ROWS = 2000;

const STORE_PREFIX = `${kebab('Store')}:`;
const ITEM_PREFIX = `${kebab('StockItem')}:`;
const LEVEL_PREFIX = `${kebab('StockLevel')}:`;

const live = (doc: Document, id: string): GraphNode | undefined => {
  const n = findNode(doc, id);
  return n && n.absentSince === undefined ? n : undefined;
};

const pick = <T extends string>(values: readonly T[], raw: string | undefined, fallback: T): T =>
  (values as readonly string[]).includes(raw ?? '') ? (raw as T) : fallback;

// ---------------------------------------------------------------------------
// Reading

export interface StoreView {
  id: string;
  name: string;
  place: string | null;
  note: string | null;
}

export interface StockItemView {
  id: string;
  part: StockPart;
  model: string | null;
  name: string | null;
  serial: string | null;
  /** How many; 1 when the item does not say. */
  count: number;
  state: StockState;
  storeId: string | null;
  bin: string | null;
  optic: Optic | null;
  due: string | null;
  rma: string | null;
  lentTo: string | null;
  cameFrom: string | null;
  note: string | null;
  /** The plan step it is kept for, while reserved. */
  reservedFor: string | null;
  /** The issue it went away for, while in repair. */
  forIssue: string | null;
}

export interface StockLevelView {
  id: string;
  model: string;
  atLeast: number;
  /** Spares of that model on hand now: state spare, counts added up. */
  have: number;
  /** How many of them are on order. */
  onOrder: number;
}

function readStore(n: GraphNode): StoreView {
  const s = (key: string) => asString(fieldValue(n.fields, key)) ?? null;
  return { id: n.id, name: s('Store.name') ?? '', place: s('Store.place'), note: s('Store.note') };
}

const target = (doc: Document, id: string, kind: 'InStore' | 'ReservedFor' | 'ForIssue'): string | null =>
  edgesOut(doc, id, kind).find((e) => live(doc, e.to) !== undefined)?.to ?? null;

function readItem(doc: Document, n: GraphNode): StockItemView {
  const s = (key: string) => asString(fieldValue(n.fields, `StockItem.${key}`)) ?? null;
  const optic = fieldValue(n.fields, 'StockItem.optic');
  return {
    id: n.id,
    part: pick(STOCK_PARTS, s('part') ?? undefined, 'other'),
    model: s('model'),
    name: s('name'),
    serial: s('serial'),
    count: asNumber(fieldValue(n.fields, 'StockItem.count')) ?? 1,
    state: pick(STOCK_STATES, s('state') ?? undefined, 'spare'),
    storeId: target(doc, n.id, 'InStore'),
    bin: s('bin'),
    optic: optic === undefined ? null : (opticOf({ ...n, fields: { 'PhysicalPort.transceiver': n.fields['StockItem.optic']! } }) ?? null),
    due: s('due'),
    rma: s('rma'),
    lentTo: s('lent_to'),
    cameFrom: s('came_from'),
    note: s('note'),
    reservedFor: target(doc, n.id, 'ReservedFor'),
    forIssue: target(doc, n.id, 'ForIssue'),
  };
}

const byText = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

/** What an item is called in a list: its name, else its model, else its sort. */
export function itemTitle(item: Pick<StockItemView, 'name' | 'model' | 'part'>): string {
  return item.name ?? item.model ?? PART_LABEL[item.part];
}

/** Every live store, by name. */
export function listStores(doc: Document): StoreView[] {
  return doc.nodes
    .filter((n) => n.absentSince === undefined && n.id.startsWith(STORE_PREFIX))
    .map(readStore)
    .sort((a, b) => byText(a.name, b.name) || (a.id < b.id ? -1 : 1));
}

export function storeById(doc: Document, id: string): StoreView | null {
  const n = live(doc, id);
  return n && id.startsWith(STORE_PREFIX) ? readStore(n) : null;
}

/** True when `id` names a store; a scanned label is read by its id prefix. */
export const isStoreId = (id: string): boolean => id.startsWith(STORE_PREFIX);
export const isStockItemId = (id: string): boolean => id.startsWith(ITEM_PREFIX);

export interface StockFilter {
  states?: readonly StockState[];
  parts?: readonly StockPart[];
  /** `null` is the items in no store. */
  storeId?: string | null;
  model?: string;
}

/** Every live item, by sort, then title, then serial. */
export function listStock(doc: Document, filter: StockFilter = {}): StockItemView[] {
  const out: StockItemView[] = [];
  for (const n of doc.nodes) {
    if (n.absentSince !== undefined || !n.id.startsWith(ITEM_PREFIX)) continue;
    const item = readItem(doc, n);
    if (filter.states && !filter.states.includes(item.state)) continue;
    if (filter.parts && !filter.parts.includes(item.part)) continue;
    if (filter.storeId !== undefined && item.storeId !== filter.storeId) continue;
    if (filter.model !== undefined && item.model !== filter.model) continue;
    out.push(item);
  }
  return out.sort(
    (a, b) =>
      STOCK_PARTS.indexOf(a.part) - STOCK_PARTS.indexOf(b.part) ||
      byText(itemTitle(a), itemTitle(b)) ||
      byText(a.serial ?? '', b.serial ?? '') ||
      (a.id < b.id ? -1 : 1),
  );
}

export function stockItem(doc: Document, id: string): StockItemView | null {
  const n = live(doc, id);
  return n && id.startsWith(ITEM_PREFIX) ? readItem(doc, n) : null;
}

/** A store and what is in it, bin by bin (no bin first), for the store page a bin label opens. */
export interface StorePage {
  store: StoreView;
  bins: { bin: string | null; items: StockItemView[] }[];
  /** Items in it that count as on hand: spare or reserved. */
  onHand: number;
}

export function storeView(doc: Document, storeId: string): StorePage | null {
  const store = storeById(doc, storeId);
  if (!store) return null;
  const items = listStock(doc, { storeId }).filter((i) => i.state !== 'retired');
  const bins = new Map<string | null, StockItemView[]>();
  for (const i of items) bins.set(i.bin, [...(bins.get(i.bin) ?? []), i]);
  const order = [...bins.keys()].sort((a, b) => (a === null ? -1 : b === null ? 1 : byText(a, b)));
  return {
    store,
    bins: order.map((bin) => ({ bin, items: bins.get(bin)! })),
    onHand: items.filter((i) => i.state === 'spare' || i.state === 'reserved').reduce((n, i) => n + i.count, 0),
  };
}

/** Every stock level, by model, with what is on hand against it. */
export function stockLevels(doc: Document): StockLevelView[] {
  const spare = new Map<string, number>();
  const ordered = new Map<string, number>();
  for (const i of listStock(doc, { states: ['spare', 'on_order'] })) {
    if (i.model === null) continue;
    const m = i.state === 'spare' ? spare : ordered;
    m.set(i.model, (m.get(i.model) ?? 0) + i.count);
  }
  return doc.nodes
    .filter((n) => n.absentSince === undefined && n.id.startsWith(LEVEL_PREFIX))
    .map((n) => {
      const model = asString(fieldValue(n.fields, 'StockLevel.model')) ?? '';
      return {
        id: n.id,
        model,
        atLeast: asNumber(fieldValue(n.fields, 'StockLevel.at_least')) ?? 0,
        have: spare.get(model) ?? 0,
        onOrder: ordered.get(model) ?? 0,
      };
    })
    .sort((a, b) => byText(a.model, b.model) || (a.id < b.id ? -1 : 1));
}

/** The levels a design is short of, for Gaps and the `stock.below-minimum` check. */
export const belowMinimum = (doc: Document): StockLevelView[] => stockLevels(doc).filter((l) => l.have < l.atLeast);

/** The part a fitted Card, PowerSupply or optic port is: what a spare for it must be. */
export function partOf(doc: Document, partId: string): { part: StockPart; model: string | null; serial: string | null } | null {
  const n = live(doc, partId);
  if (!n) return null;
  switch (parseNodeId(partId).kind) {
    case 'Card':
      return { part: 'card', model: asString(fieldValue(n.fields, 'Card.model')) ?? null, serial: asString(fieldValue(n.fields, 'Card.serial')) ?? null };
    case 'PowerSupply': {
      const f = readPowerSupplyFields(n);
      return { part: 'power_supply', model: f.model ?? null, serial: f.serial ?? null };
    }
    case 'PhysicalPort': {
      const o = opticOf(n);
      return o ? { part: 'optic', model: o.part ?? null, serial: o.serial ?? null } : null;
    }
    default:
      return null;
  }
}

/** The spares that could go in for a part: the same sort, spare or reserved for `stepId`, its model first. */
export function sparesFor(doc: Document, partId: string, stepId?: string): StockItemView[] {
  const p = partOf(doc, partId);
  if (!p) return [];
  const fits = listStock(doc, { parts: [p.part], states: ['spare', 'reserved'] }).filter(
    (i) => i.state === 'spare' || (stepId !== undefined && i.reservedFor === stepId),
  );
  const same = (i: StockItemView): number => (p.model !== null && i.model === p.model ? 0 : 1);
  return fits.sort((a, b) => same(a) - same(b));
}

/** Where a fitted part is, in words, frozen into `came_from` when it comes out: "core-sw1 · slot 1". */
export function whereFitted(doc: Document, partId: string): string {
  const host = (chassisId: string | null): string => {
    if (chassisId === null) return '';
    const device = edgesIn(doc, chassisId, 'HasChassis')[0]?.from;
    const d = device ? findNode(doc, device) : undefined;
    return (d && asString(fieldValue(d.fields, 'Device.hostname'))) ?? '';
  };
  const join = (...parts: string[]): string => parts.filter((p) => p !== '').join(' · ');
  const n = findNode(doc, partId);
  if (!n) return '';
  switch (parseNodeId(partId).kind) {
    case 'Card':
      return join(host(chassisOfCard(doc, partId)), slotPath(doc, partId));
    case 'PowerSupply': {
      const chassis = edgesIn(doc, partId, 'FittedIn')[0]?.from ?? null;
      const slot = readPowerSupplyFields(n).slot;
      return join(host(chassis), slot ? `power ${slot}` : '');
    }
    case 'PhysicalPort': {
      const chassis = edgesIn(doc, partId, 'HasPort').find((e) => parseNodeId(e.from).kind === 'Chassis')?.from ?? null;
      return join(host(chassis), readPhysicalPortFields(n).label ?? '');
    }
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// What a person types

function words(raw: string | null | undefined, what: string, max = MAX_WORDS): string | undefined {
  const v = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (v === '') return undefined;
  if (v.length > max) throw new StockRefusal(`${what} is at most ${max} characters.`);
  return v;
}

function oneWord(raw: string | null | undefined, what: string): string | undefined {
  const v = (raw ?? '').trim();
  if (v === '') return undefined;
  if (!/^[\x21-\x7e]+$/.test(v)) throw new StockRefusal(`${what} is one word with no spaces: "${v}".`);
  if (v.length > MAX_WORDS) throw new StockRefusal(`${what} is at most ${MAX_WORDS} characters.`);
  return v;
}

/** An ISO date, "2026-11-04"; nothing else is stored, so a due date always sorts. */
export function cleanDue(raw: string | null | undefined): string | undefined {
  const v = (raw ?? '').trim();
  if (v === '') return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !d || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    throw new StockRefusal(`"${v}" is not a date. Write it as year-month-day, like 2026-11-04.`);
  }
  return v;
}

function cleanCount(n: number | null | undefined): number | undefined {
  if (n === null || n === undefined || n === 1) return undefined;
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000) throw new StockRefusal('A count is a whole number, 1 or more.');
  return n;
}

/** Writes one field on a node, or clears it when `value` is undefined; nothing when nothing changes. */
function putField(b: Build, id: string, key: string, value: FieldEntry['value'] | undefined): void {
  requireFieldName(key);
  const node = findNode(b.doc, id);
  if (!node) throw new StockRefusal('That is not in the design any more.');
  const existing = node.fields[key];
  const had = existing !== undefined && existing.presence === 'set' ? existing.value : undefined;
  if (JSON.stringify(had) === JSON.stringify(value)) return;
  const prov = assertHand(b.doc, { assertedAt: b.now, assertedBy: b.actor, supersedes: existing?.prov });
  b.doc = existing !== undefined ? archiveField(prov.doc, id, key, existing) : prov.doc;
  const next: FieldEntry = value === undefined ? { presence: 'absent', prov: prov.id } : { presence: 'set', prov: prov.id, value };
  b.ops.push({ type: 'set_field', element: id, key, presence: next.presence, prov: prov.id });
  b.doc = replaceNode(b.doc, id, (n) => ({ ...n, fields: { ...n.fields, [key]: next } }));
}

/** Points `id`'s one edge of `kind` at `to`, or takes it away when `to` is null. */
function putEdge(b: Build, id: string, kind: 'InStore' | 'ReservedFor' | 'ForIssue', to: string | null): void {
  const had = edgesOut(b.doc, id, kind);
  if (to !== null && had.length === 1 && had[0]!.to === to) return;
  if (had.length > 0) tombstone(b, new Set(), new Set(had.map((e) => e.id)));
  if (to !== null) addEdge(b, kind, id, to);
}

function requireStore(doc: Document, id: string): StoreView {
  const s = storeById(doc, id);
  if (!s) throw new StockRefusal('That store is not in the design any more.');
  return s;
}

function requireItem(doc: Document, id: string): StockItemView {
  const i = stockItem(doc, id);
  if (!i) throw new StockRefusal('That item is not in stock any more.');
  return i;
}

function requireKind(doc: Document, id: string, kind: 'PlanStep' | 'Issue'): void {
  if (!live(doc, id) || parseNodeId(id).kind !== kind) {
    throw new StockRefusal(kind === 'PlanStep' ? 'That plan step is not in the design any more.' : 'That issue is not in the design any more.');
  }
}

// ---------------------------------------------------------------------------
// Stores

export interface StorePatch {
  name?: string;
  /** `null` or '' clears it. */
  place?: string | null;
  note?: string | null;
}

function writeStore(b: Build, id: string, patch: StorePatch): void {
  if (patch.name !== undefined) {
    const name = words(patch.name, 'A name', MAX_NAME);
    if (name === undefined) throw new StockRefusal('Give the store a name.');
    putField(b, id, 'Store.name', text(name));
  }
  if (patch.place !== undefined) {
    const v = words(patch.place, 'A place');
    putField(b, id, 'Store.place', v === undefined ? undefined : text(v));
  }
  if (patch.note !== undefined) {
    const v = words(patch.note, 'A note', MAX_NOTE);
    putField(b, id, 'Store.note', v === undefined ? undefined : text(v));
  }
}

/** Makes a store. One undo step. */
export function addStore(doc: Document, input: { name: string; place?: string; note?: string }, opts?: Actor): { doc: Document; id: string } {
  const name = words(input.name, 'A name', MAX_NAME);
  if (name === undefined) throw new StockRefusal('Give the store a name.');
  const b = begin(doc, opts);
  const id = addNode(b, 'Store', { 'Store.name': text(name) });
  writeStore(b, id, { place: input.place, note: input.note });
  return { doc: finish(b, 'add store'), id };
}

export function setStore(doc: Document, id: string, patch: StorePatch, opts?: Actor): Document {
  requireStore(doc, id);
  const b = begin(doc, opts);
  writeStore(b, id, patch);
  return finish(b, 'change store');
}

/** Removes a store. What was in it stays in stock, in no store. */
export function removeStore(doc: Document, id: string, opts?: Actor): Document {
  requireStore(doc, id);
  const b = begin(doc, opts);
  tombstone(b, new Set([id]), new Set(edgesIn(doc, id, 'InStore').map((e) => e.id)));
  return finish(b, 'remove store');
}

// ---------------------------------------------------------------------------
// Items

export interface NewStock {
  part: StockPart;
  model?: string;
  name?: string;
  serial?: string;
  /** For things without a serial. Left out, or 1, is one. */
  count?: number;
  /** Left out is `spare`. */
  state?: StockState;
  storeId?: string | null;
  bin?: string;
  optic?: Optic;
  due?: string;
  rma?: string;
  lentTo?: string;
  cameFrom?: string;
  note?: string;
}

export type StockPatch = { [K in Exclude<keyof NewStock, 'part' | 'state'>]?: NewStock[K] | null } & { part?: StockPart };

function writeItem(b: Build, id: string, patch: StockPatch): void {
  const f = (key: string, value: FieldEntry['value'] | undefined) => putField(b, id, `StockItem.${key}`, value);
  if (patch.part !== undefined) f('part', token(pick(STOCK_PARTS, patch.part, 'other')));
  if (patch.model !== undefined) {
    const v = oneWord(patch.model, 'A model');
    f('model', v === undefined ? undefined : identifier(v));
  }
  if (patch.serial !== undefined) {
    const v = oneWord(patch.serial, 'A serial');
    f('serial', v === undefined ? undefined : identifier(v));
  }
  for (const [key, field, what, max] of [
    ['name', 'name', 'A name', MAX_NAME],
    ['bin', 'bin', 'A bin', MAX_WORDS],
    ['rma', 'rma', 'An RMA number', MAX_WORDS],
    ['lentTo', 'lent_to', 'Who has it', MAX_WORDS],
    ['cameFrom', 'came_from', 'Where it came from', MAX_WORDS],
    ['note', 'note', 'A note', MAX_NOTE],
  ] as const) {
    const raw = patch[key];
    if (raw === undefined) continue;
    const v = words(raw, what, max);
    f(field, v === undefined ? undefined : text(v));
  }
  if (patch.count !== undefined) {
    const v = cleanCount(patch.count);
    f('count', v === undefined ? undefined : uint(v, 32));
  }
  if (patch.due !== undefined) {
    const v = cleanDue(patch.due);
    f('due', v === undefined ? undefined : text(v));
  }
  if (patch.optic !== undefined) f('optic', patch.optic === null ? undefined : encodeOptic(patch.optic));
  if (patch.storeId !== undefined) {
    if (patch.storeId !== null) requireStore(b.doc, patch.storeId);
    putEdge(b, id, 'InStore', patch.storeId);
  }
}

function addOne(b: Build, input: NewStock): string {
  const id = addNode(b, 'StockItem', {
    'StockItem.part': token(pick(STOCK_PARTS, input.part, 'other')),
    'StockItem.state': token(pick(STOCK_STATES, input.state, 'spare')),
  });
  if (input.serial && input.count !== undefined && input.count !== 1) throw new StockRefusal('A thing with a serial is one item; give a count only to things without one.');
  const { part: _part, state: _state, ...rest } = input;
  writeItem(b, id, rest);
  return id;
}

/** Adds one item, or many (a paste, a file, a box of optics): one undo step either way. A serial already in
 * stock is refused, so a second paste of the same list adds nothing twice. */
export function addStock(doc: Document, input: NewStock | readonly NewStock[], opts?: Actor): { doc: Document; ids: string[] } {
  const rows = Array.isArray(input) ? (input as readonly NewStock[]) : [input as NewStock];
  if (rows.length === 0) return { doc, ids: [] };
  if (rows.length > MAX_ROWS) throw new StockRefusal(`At most ${MAX_ROWS} rows at once.`);
  const serials = new Set(listStock(doc).map((i) => i.serial).filter((s): s is string => s !== null));
  const b = begin(doc, opts);
  const ids: string[] = [];
  for (const row of rows) {
    const serial = row.serial?.trim();
    if (serial) {
      if (serials.has(serial)) throw new StockRefusal(`${serial} is in stock already.`);
      serials.add(serial);
    }
    ids.push(addOne(b, row));
  }
  return { doc: finish(b, rows.length === 1 ? 'add to stock' : `add ${rows.length} to stock`), ids };
}

/** Changes what an item says; what is left out is left as it is. Its state moves through the verbs below. */
export function setStockItem(doc: Document, id: string, patch: StockPatch, opts?: Actor): Document {
  requireItem(doc, id);
  const b = begin(doc, opts);
  writeItem(b, id, patch);
  return finish(b, 'change stock');
}

/** Moves an item to another state, clearing what only the old one needed. */
function moveTo(b: Build, item: StockItemView, state: StockState): void {
  putField(b, item.id, 'StockItem.state', token(state));
  if (state !== 'reserved') putEdge(b, item.id, 'ReservedFor', null);
  if (state !== 'lent') putField(b, item.id, 'StockItem.lent_to', undefined);
  if (state !== 'in_repair') {
    putField(b, item.id, 'StockItem.rma', undefined);
    putEdge(b, item.id, 'ForIssue', null);
  }
  if (state === 'spare' || state === 'retired' || state === 'reserved') putField(b, item.id, 'StockItem.due', undefined);
}

/** Splits `n` off a counted item when only some of it moves; the rest stays where it was. Returns the id that moves. */
function split(b: Build, item: StockItemView, n: number | undefined): string {
  if (n === undefined || n >= item.count) return item.id;
  if (!Number.isInteger(n) || n < 1) throw new StockRefusal('Take a whole number, 1 or more.');
  putField(b, item.id, 'StockItem.count', item.count - n === 1 ? undefined : uint(item.count - n, 32));
  const { id: _id, part, state, reservedFor: _r, forIssue: _f, count: _c, optic, ...rest } = item;
  const copy: NewStock = { part, state };
  for (const [k, v] of Object.entries(rest)) if (v !== null) (copy as unknown as Record<string, unknown>)[k] = v;
  if (optic) copy.optic = optic;
  copy.count = n;
  return addOne(b, copy);
}

function verb(doc: Document, id: string, label: string, opts: Actor | undefined, body: (b: Build, item: StockItemView) => void): Document {
  const item = requireItem(doc, id);
  const b = begin(doc, opts);
  body(b, item);
  return finish(b, label);
}

/** It arrived, came back from repair, or was given back: a spare again. */
export function backToSpare(doc: Document, id: string, opts?: Actor & { storeId?: string | null; bin?: string | null }): Document {
  return verb(doc, id, 'back in stock', opts, (b, item) => {
    moveTo(b, item, 'spare');
    writeItem(b, item.id, { storeId: opts?.storeId, bin: opts?.bin });
  });
}

/** Keeps an item for a plan step, so nobody else takes it. `count` splits that many off a counted item. */
export function reserve(doc: Document, id: string, stepId: string, opts?: Actor & { count?: number }): Document {
  requireKind(doc, stepId, 'PlanStep');
  return verb(doc, id, 'reserve spare', opts, (b, item) => {
    if (item.state !== 'spare' && item.state !== 'reserved') throw new StockRefusal(`Only a spare can be reserved; this one is ${STATE_LABEL[item.state].toLowerCase()}.`);
    const movingId = split(b, item, opts?.count);
    const moving = requireItem(b.doc, movingId);
    moveTo(b, moving, 'reserved');
    putEdge(b, moving.id, 'ReservedFor', stepId);
  });
}

/** Sends an item away for repair, with the vendor's RMA number, when it is due back, and the issue it is for. */
export function sendToRepair(doc: Document, id: string, input: { rma?: string; due?: string; issueId?: string | null } = {}, opts?: Actor): Document {
  if (input.issueId) requireKind(doc, input.issueId, 'Issue');
  return verb(doc, id, 'send for repair', opts, (b, item) => {
    moveTo(b, item, 'in_repair');
    writeItem(b, item.id, { rma: input.rma, due: input.due });
    if (input.issueId !== undefined) putEdge(b, item.id, 'ForIssue', input.issueId);
  });
}

/** Lends an item out: who has it and when it is due back. `count` splits that many off a counted item. */
export function lend(doc: Document, id: string, input: { to: string; due?: string; count?: number }, opts?: Actor): Document {
  const to = words(input.to, 'Who has it');
  if (to === undefined) throw new StockRefusal('Say who has it.');
  return verb(doc, id, 'lend', opts, (b, item) => {
    const movingId = split(b, item, input.count);
    const moving = requireItem(b.doc, movingId);
    moveTo(b, moving, 'lent');
    writeItem(b, moving.id, { lentTo: to, due: input.due });
  });
}

/** Marks an item ordered, with when it is due. */
export function markOnOrder(doc: Document, id: string, input: { due?: string } = {}, opts?: Actor): Document {
  return verb(doc, id, 'on order', opts, (b, item) => {
    moveTo(b, item, 'on_order');
    writeItem(b, item.id, { due: input.due });
  });
}

/** Retires an item: dead, scrapped, or gone back for good. It stays listed under Retired so its serial still reads. */
export function retire(doc: Document, id: string, opts?: Actor): Document {
  return verb(doc, id, 'retire', opts, (b, item) => moveTo(b, item, 'retired'));
}

/** Takes `count` of an item out of stock (a lead used, an optic fitted by hand): the item ends, or its count drops. */
export function takeFromStock(doc: Document, id: string, count?: number, opts?: Actor): Document {
  return verb(doc, id, 'take from stock', opts, (b, item) => {
    const n = count ?? 1;
    if (!Number.isInteger(n) || n < 1) throw new StockRefusal('Take a whole number, 1 or more.');
    if (n > item.count) throw new StockRefusal(`There ${item.count === 1 ? 'is' : 'are'} only ${item.count}.`);
    if (n === item.count) removeItem(b, item.id);
    else putField(b, item.id, 'StockItem.count', item.count - n === 1 ? undefined : uint(item.count - n, 32));
  });
}

function removeItem(b: Build, id: string): void {
  const edges = (['InStore', 'ReservedFor', 'ForIssue'] as const).flatMap((k) => edgesOut(b.doc, id, k).map((e) => e.id));
  tombstone(b, new Set([id]), new Set(edges));
}

/** Removes an item typed by mistake. Something used or fitted goes through `takeFromStock` or a swap instead. */
export function removeStock(doc: Document, id: string, opts?: Actor): Document {
  return verb(doc, id, 'remove from stock', opts, (b, item) => removeItem(b, item.id));
}

// ---------------------------------------------------------------------------
// Stock levels

/** Keeps at least `atLeast` spares of `model`; 0 removes the level. One level per model: setting one again changes it. */
export function setStockLevel(doc: Document, model: string, atLeast: number, opts?: Actor): Document {
  const m = oneWord(model, 'A model');
  if (m === undefined) throw new StockRefusal('Name the model.');
  if (!Number.isInteger(atLeast) || atLeast < 0 || atLeast > 1_000_000) throw new StockRefusal('Keep a whole number, 0 or more.');
  const had = stockLevels(doc).filter((l) => l.model === m);
  const b = begin(doc, opts);
  if (atLeast === 0) {
    tombstone(b, new Set(had.map((l) => l.id)), new Set());
  } else if (had.length === 0) {
    addNode(b, 'StockLevel', { 'StockLevel.model': identifier(m), 'StockLevel.at_least': uint(atLeast, 32) });
  } else {
    setNodeFieldIfChanged(b, had[0]!.id, 'StockLevel.at_least', atLeast);
    if (had.length > 1) tombstone(b, new Set(had.slice(1).map((l) => l.id)), new Set());
  }
  return finish(b, atLeast === 0 ? 'remove stock level' : 'set stock level');
}

function setNodeFieldIfChanged(b: Build, id: string, key: string, n: number): void {
  if (asNumber(fieldValue(findNode(b.doc, id)!.fields, key)) === n) return;
  setNodeField(b, id, key, uint(n, 32));
}

// ---------------------------------------------------------------------------
// Fitting from stock, and what comes out

/** What happens to the part that comes out: back on the shelf, away for repair, retired, or not kept at all. */
export type OldPartTo = 'spare' | 'in_repair' | 'retired' | 'gone';

export interface SwapFromStock extends Actor {
  oldTo: OldPartTo;
  /** For `in_repair`: the RMA number, when it is due back, and the issue it is for. */
  rma?: string;
  due?: string;
  issueId?: string | null;
  /** Where the old part goes, when it stays. */
  storeId?: string | null;
  bin?: string;
}

/** Fits a spare in place of a fitted Card, PowerSupply or optic: the part takes the spare's model and serial
 * (an optic its whole description), the spare leaves stock, and the old part becomes an item that remembers
 * where it was. One undo step. */
export function swapFromStock(doc: Document, partId: string, itemId: string, opts: SwapFromStock): Document {
  const old = partOf(doc, partId);
  if (!old) throw new StockRefusal('That part is not in the design any more.');
  const spare = requireItem(doc, itemId);
  if (spare.state !== 'spare' && spare.state !== 'reserved') throw new StockRefusal(`That item is ${STATE_LABEL[spare.state].toLowerCase()}, not on hand.`);
  if (spare.part !== old.part) throw new StockRefusal(`That is a ${PART_LABEL[spare.part].toLowerCase()}, and this is a ${PART_LABEL[old.part].toLowerCase()}.`);
  const from = doc.batches.length;
  const now = opts.now ?? Date.now();
  const at = { actor: opts.actor, now };
  const where = whereFitted(doc, partId);
  const port = parseNodeId(partId).kind === 'PhysicalPort' ? findNode(doc, partId) : undefined;
  const oldOptic = port ? opticOf(port) : undefined;

  let working = fitSpare(doc, partId, spare, at);
  working = takeFromStock(working, spare.id, 1, at);
  if (opts.oldTo !== 'gone') {
    const kept: NewStock = {
      part: old.part,
      state: opts.oldTo,
      model: old.model ?? undefined,
      serial: old.serial ?? undefined,
      cameFrom: where || undefined,
      storeId: (opts.storeId !== undefined ? opts.storeId : spare.storeId) ?? undefined,
      bin: opts.bin,
      optic: oldOptic ?? undefined,
      rma: opts.oldTo === 'in_repair' ? opts.rma : undefined,
      due: opts.oldTo === 'in_repair' ? opts.due : undefined,
    };
    const added = addStockAllowingDuplicate(working, kept, at);
    working = added.doc;
    if (opts.oldTo === 'in_repair' && opts.issueId) {
      requireKind(working, opts.issueId, 'Issue');
      const b = begin(working, at);
      putEdge(b, added.id, 'ForIssue', opts.issueId);
      working = finish(b, 'for issue');
    }
  }
  return relabel(foldFrom(working, from), from, 'swap part from stock');
}

/** The old part's own serial was never in stock, but a design typed twice could hold it: it is kept anyway. */
function addStockAllowingDuplicate(doc: Document, input: NewStock, opts: Actor): { doc: Document; id: string } {
  const b = begin(doc, opts);
  const id = addOne(b, input);
  return { doc: finish(b, 'into stock'), id };
}

function fitSpare(doc: Document, partId: string, spare: StockItemView, opts: Actor): Document {
  switch (parseNodeId(partId).kind) {
    case 'Card': {
      const w = setCardField(doc, partId, 'serial', spare.serial, opts);
      return spare.model === null ? w : setCardField(w, partId, 'model', spare.model, opts);
    }
    case 'PowerSupply': {
      const w = setSupplyField(doc, partId, 'serial', spare.serial, opts);
      return spare.model === null ? w : setSupplyField(w, partId, 'model', spare.model, opts);
    }
    default: {
      const optic: Optic = { ...(spare.optic ?? {}) };
      if (spare.model !== null) optic.part = spare.model;
      if (spare.serial !== null) optic.serial = spare.serial;
      else delete optic.serial;
      return setOptic(doc, partId, optic, opts);
    }
  }
}

/** Takes a fitted part's details into stock without changing the drawing: for a part about to come out by hand.
 * `partId` is the Card, PowerSupply or optic port. */
export function stockFromFitted(doc: Document, partId: string, state: StockState, opts?: Actor & { storeId?: string | null; bin?: string }): { doc: Document; id: string } {
  const p = partOf(doc, partId);
  if (!p) throw new StockRefusal('That part is not in the design any more.');
  const port = parseNodeId(partId).kind === 'PhysicalPort' ? findNode(doc, partId) : undefined;
  const b = begin(doc, opts);
  const id = addOne(b, {
    part: p.part,
    state,
    model: p.model ?? undefined,
    serial: p.serial ?? undefined,
    cameFrom: whereFitted(doc, partId) || undefined,
    storeId: opts?.storeId ?? undefined,
    bin: opts?.bin,
    optic: (port && opticOf(port)) || undefined,
  });
  return { doc: finish(b, 'into stock'), id };
}

/** Takes a fitted part out of the drawing and into stock in one undo step: the card (and its ports) or power supply
 * comes out, an optic's cage is marked empty, and the part becomes an item that remembers where it was. */
export function takeOutToStock(doc: Document, partId: string, state: StockState, opts?: Actor & { storeId?: string | null; bin?: string }): { doc: Document; id: string } {
  const from = doc.batches.length;
  const now = opts?.now ?? Date.now();
  const at = { ...opts, now };
  const kept = stockFromFitted(doc, partId, state, at);
  const kind = parseNodeId(partId).kind;
  const out = kind === 'Card' ? removeCard(kept.doc, partId, at) : kind === 'PowerSupply' ? removeSupply(kept.doc, partId, at) : setOptic(kept.doc, partId, null, at);
  return { doc: relabel(foldFrom(out, from), from, 'take out into stock'), id: kept.id };
}

/** The item reserved for a plan step, if one is. */
export function reservedFor(doc: Document, stepId: string): StockItemView | null {
  const e = edgesIn(doc, stepId, 'ReservedFor').find((x) => live(doc, x.from) !== undefined);
  return e ? stockItem(doc, e.from) : null;
}

/** Items away for an issue's repair. */
export function stockForIssue(doc: Document, issueId: string): StockItemView[] {
  return edgesIn(doc, issueId, 'ForIssue')
    .map((e) => stockItem(doc, e.from))
    .filter((i): i is StockItemView => i !== null);
}

function relabel(doc: Document, from: number, label: string): Document {
  if (doc.batches.length <= from) return doc;
  const last = doc.batches.length - 1;
  return { ...doc, batches: [...doc.batches.slice(0, last), { ...doc.batches[last]!, label }] };
}

// ---------------------------------------------------------------------------
// Paste and file

/** What a device's own `show inventory` or `show chassis hardware` lists, as stock rows: a box of spares
 * read in a lab switch, or a returned unit's parts. The pasted text is read in the browser and never stored. */
export function stockFromFacts(facts: DeviceFacts, defaults: Pick<NewStock, 'storeId' | 'bin' | 'state'> = {}): NewStock[] {
  const out: NewStock[] = [];
  for (const p of facts.parts ?? []) {
    if (!p.model && !p.serial) continue;
    const part: StockPart = p.kind === 'supply' ? 'power_supply' : p.kind;
    out.push({
      ...defaults,
      part,
      model: p.model,
      serial: p.serial,
      name: p.description,
      optic: part === 'optic' ? { part: p.model, serial: p.serial, type: p.description } : undefined,
    });
  }
  return out;
}

const HEADER_WORDS: Record<string, keyof NewStock> = {
  part: 'part',
  kind: 'part',
  type: 'part',
  sort: 'part',
  model: 'model',
  pid: 'model',
  'part number': 'model',
  'part no': 'model',
  sku: 'model',
  name: 'name',
  description: 'name',
  descr: 'name',
  item: 'name',
  serial: 'serial',
  'serial number': 'serial',
  sn: 'serial',
  count: 'count',
  qty: 'count',
  quantity: 'count',
  state: 'state',
  status: 'state',
  bin: 'bin',
  shelf: 'bin',
  location: 'bin',
  due: 'due',
  rma: 'rma',
  note: 'note',
  notes: 'note',
};

const PART_WORDS: Record<string, StockPart> = {
  card: 'card',
  module: 'card',
  linecard: 'card',
  'line card': 'card',
  optic: 'optic',
  sfp: 'optic',
  transceiver: 'optic',
  xcvr: 'optic',
  psu: 'power_supply',
  'power supply': 'power_supply',
  power_supply: 'power_supply',
  device: 'device',
  switch: 'device',
  router: 'device',
  cable: 'cable',
  lead: 'cable',
  'patch lead': 'cable',
  other: 'other',
};

const STATE_WORDS: Record<string, StockState> = {
  spare: 'spare',
  'on hand': 'spare',
  reserved: 'reserved',
  'on order': 'on_order',
  on_order: 'on_order',
  ordered: 'on_order',
  repair: 'in_repair',
  'in repair': 'in_repair',
  in_repair: 'in_repair',
  rma: 'in_repair',
  lent: 'lent',
  retired: 'retired',
  dead: 'retired',
};

/** A part's sort guessed from its model when no column says: optics and power supplies have tell-tale names. */
export function guessPart(model: string | undefined, name?: string): StockPart {
  const s = `${model ?? ''} ${name ?? ''}`.toUpperCase();
  if (/\b(Q?SFP(28|56|-DD|\+)?|XFP|GBIC|CFP\d?|OSFP)\b|SFP-|QSFP|TRANSCEIVER|XCVR|-SR\b|-LR\b/.test(s)) return 'optic';
  if (/\b(PWR|PSU|PEM)\b|PWR-|POWER SUPPLY/.test(s)) return 'power_supply';
  if (/\b(CAT ?5E?|CAT ?6A?|PATCH|LEAD|CABLE|DAC|AOC)\b/.test(s)) return 'cable';
  return 'other';
}

function splitRow(line: string, sep: string): string[] {
  if (sep !== ',') return line.split(sep).map((c) => c.trim());
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cell.trim());
      cell = '';
    } else cell += c;
  }
  out.push(cell.trim());
  return out;
}

export interface ReadRows {
  rows: NewStock[];
  /** Lines that were not read, with why, for the dialog to show. */
  skipped: { line: number; why: string }[];
}

/** Reads a pasted list or a CSV/TSV file. With a header row, columns are matched by name ("Model", "Serial",
 * "Qty", "Bin"...); without one, each line is a model and optionally a serial, separated by spaces or a tab.
 * Columns it does not know (a price, a supplier) are left for custom fields and named in `skipped` once. */
export function readStockRows(raw: string, defaults: Pick<NewStock, 'storeId' | 'bin' | 'state'> = {}): ReadRows {
  const lines = raw.split(/\r?\n/);
  const first = lines.find((l) => l.trim() !== '') ?? '';
  const sep = first.includes('\t') ? '\t' : first.includes(',') ? ',' : '';
  const skipped: ReadRows['skipped'] = [];
  const rows: NewStock[] = [];
  const head = sep ? splitRow(first, sep).map((h) => h.toLowerCase().replace(/[#.:_]/g, ' ').replace(/\s+/g, ' ').trim()) : [];
  const columns = head.map((h) => HEADER_WORDS[h]);
  const hasHeader = columns.some((c) => c === 'model' || c === 'serial' || c === 'name');
  const unknown = head.filter((_, i) => hasHeader && columns[i] === undefined && head[i] !== '');
  if (unknown.length > 0) skipped.push({ line: 1, why: `Columns not read: ${unknown.join(', ')}. Add them as custom fields to keep them.` });
  let started = !hasHeader;
  lines.forEach((line, index) => {
    if (line.trim() === '' || line.trim().startsWith('#')) return;
    if (!started) {
      started = true;
      return;
    }
    const n = index + 1;
    const row: NewStock = { part: 'other', ...defaults };
    let partSaid = false;
    if (hasHeader) {
      const cells = splitRow(line, sep);
      columns.forEach((col, i) => {
        const v = cells[i]?.trim();
        if (!col || !v) return;
        if (col === 'part') {
          const p = PART_WORDS[v.toLowerCase()];
          if (p) {
            row.part = p;
            partSaid = true;
          }
        } else if (col === 'state') {
          const s = STATE_WORDS[v.toLowerCase()];
          if (s) row.state = s;
        } else if (col === 'count') {
          const c = Number(v);
          if (Number.isInteger(c) && c >= 1) row.count = c;
        } else (row as unknown as Record<string, string>)[col] = v;
      });
    } else {
      const cells = sep ? splitRow(line, sep).filter((c) => c !== '') : line.trim().split(/\s+/);
      row.model = cells[0];
      if (cells[1]) row.serial = cells[1];
      if (cells.length > 2) row.name = cells.slice(2).join(' ');
    }
    if (!row.model && !row.serial && !row.name) {
      skipped.push({ line: n, why: 'nothing to read' });
      return;
    }
    for (const [k, what] of [['model', 'model'], ['serial', 'serial']] as const) {
      const v = row[k];
      if (v !== undefined && !/^[\x21-\x7e]+$/.test(v)) {
        skipped.push({ line: n, why: `the ${what} "${v}" has a space in it` });
        return;
      }
    }
    if (!partSaid) row.part = guessPart(row.model, row.name);
    if (row.serial && row.count !== undefined && row.count !== 1) {
      skipped.push({ line: n, why: 'a serial and a count; a thing with a serial is one item' });
      return;
    }
    if (row.part === 'optic' && row.model) row.optic = { part: row.model, ...(row.serial ? { serial: row.serial } : {}) };
    rows.push(row);
  });
  return { rows, skipped };
}
