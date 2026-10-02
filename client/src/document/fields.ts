// ADR-0062: a custom field is a `FieldDef` node (name, which kind it applies to, its type) and
// a value is a `FieldValue` node owned by the thing through `HasFieldValue` and pointing at its
// definition through `ValueOf`. Definitions hang off the root with no edge (Tag's own reason).
// Shared fields only: a private field needs a per-account store (ADR-0053 §7), which is later.

import {
  LOCAL_ACTOR,
  UnknownReferenceError,
  archiveField,
  assertHand,
  edgesIn,
  edgesOut,
  findNode,
  formatEdgeId,
  formatNodeId,
  kebab,
  parseNodeId,
  replaceNode,
  requireFieldName,
  text,
  token,
  withBatch,
  withEdge,
  withNode,
  type Batch,
  type Document,
  type FieldEntry,
  type NodeKind,
  type Op,
} from './model';
import { newUlid } from './ulid';

const DEF_PREFIX = `${kebab('FieldDef')}:`;
const VALUE_PREFIX = `${kebab('FieldValue')}:`;
const HAS_VALUE_PREFIX = `${kebab('HasFieldValue')}:`;
const VALUE_OF_PREFIX = `${kebab('ValueOf')}:`;

export const FIELD_FOR = ['device', 'rack', 'cable', 'port', 'network'] as const;
export type FieldFor = (typeof FIELD_FOR)[number];
export const FIELD_TYPES = ['text', 'number', 'yes_no', 'date'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: 'Text',
  number: 'Number',
  yes_no: 'Yes / no',
  date: 'Date',
};

const OWNER_KIND_FOR: Partial<Record<NodeKind, FieldFor>> = {
  Device: 'device',
  Rack: 'rack',
  Cable: 'cable',
  PhysicalPort: 'port',
  Vlan: 'network',
  ContainerNetwork: 'network',
};

/** Which field kind a node takes, or undefined for a node outside `Fieldable`. */
export function fieldForOwner(ownerId: string): FieldFor | undefined {
  return OWNER_KIND_FOR[parseNodeId(ownerId).kind];
}

interface Actor {
  actor?: string;
  now?: number;
}

function resolve(opts: Actor | undefined): { actor: string; now: number } {
  return { actor: opts?.actor ?? LOCAL_ACTOR, now: opts?.now ?? Date.now() };
}

export class FieldRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldRefusalError';
  }
}

function refuse(message: string): never {
  throw new FieldRefusalError(message);
}

export function normalizeFieldName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ').normalize('NFC');
  if (name.length === 0) refuse('a field name must not be blank');
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(name)) refuse('a field name must not contain control or invisible characters');
  if (Array.from(name).length > 48) refuse('a field name must be 48 characters or fewer');
  return name;
}

const foldName = (name: string): string => name.normalize('NFKC').toUpperCase().toLowerCase();

const MAX_VALUE_LENGTH = 1000;

/** The stored form of `raw` for `type`, or null when blank (a clear). Refuses by name. */
export function normalizeFieldValue(type: FieldType, raw: string): string | null {
  const v = raw.trim();
  if (v === '') return null;
  if (Array.from(v).length > MAX_VALUE_LENGTH) refuse(`a value must be ${MAX_VALUE_LENGTH} characters or fewer`);
  if (/[\p{Cc}\p{Cs}]/u.test(v.replace(/[\n\t]/g, ' '))) refuse('a value must not contain control characters');
  if (type === 'number') {
    if (!/^-?\d+(\.\d+)?$/.test(v)) refuse(`"${v}" is not a number`);
    return v;
  }
  if (type === 'yes_no') {
    const l = v.toLowerCase();
    if (['yes', 'y', 'true', '1'].includes(l)) return 'yes';
    if (['no', 'n', 'false', '0'].includes(l)) return 'no';
    refuse(`"${v}" is not yes or no`);
  }
  if (type === 'date') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
    if (!m || !d || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
      refuse(`"${v}" is not a date (use YYYY-MM-DD)`);
    }
    return v;
  }
  return v;
}

export interface FieldDefView {
  id: string;
  name: string;
  appliesTo: FieldFor;
  type: FieldType;
}

interface FieldIndex {
  /** Canonical live definitions, by id. */
  defs: ReadonlyMap<string, FieldDefView>;
  /** Any live def id (duplicates included) -> its canonical id. */
  canonical: ReadonlyMap<string, string>;
  /** Owner -> canonical def id -> its live value node and text. */
  values: ReadonlyMap<string, ReadonlyMap<string, { nodeId: string; value: string }>>;
}

const INDEX_CACHE = new WeakMap<Document, FieldIndex>();

function strField(fields: Readonly<Record<string, FieldEntry>>, key: string): string {
  const e = fields[key];
  return e && e.presence === 'set' && typeof e.value === 'string' ? e.value : '';
}

function build(doc: Document): FieldIndex {
  // `doc.nodes` is id-sorted, so the first def seen for a (kind, name) is the lowest id.
  const byKey = new Map<string, FieldDefView>();
  const canonical = new Map<string, string>();
  for (const n of doc.nodes) {
    if (n.absentSince !== undefined || !n.id.startsWith(DEF_PREFIX)) continue;
    const appliesTo = strField(n.fields, 'FieldDef.applies_to') as FieldFor;
    const type = strField(n.fields, 'FieldDef.value_type') as FieldType;
    if (!FIELD_FOR.includes(appliesTo) || !FIELD_TYPES.includes(type)) continue;
    const name = strField(n.fields, 'FieldDef.name');
    const key = `${appliesTo}:${foldName(name)}`;
    let def = byKey.get(key);
    if (!def) {
      def = { id: n.id, name, appliesTo, type };
      byKey.set(key, def);
    }
    canonical.set(n.id, def.id);
  }
  const defs = new Map<string, FieldDefView>();
  for (const d of byKey.values()) defs.set(d.id, d);

  const ownerOf = new Map<string, string>();
  const defOf = new Map<string, string>();
  for (const e of doc.edges) {
    if (e.absentSince !== undefined) continue;
    if (e.id.startsWith(HAS_VALUE_PREFIX)) ownerOf.set(e.to, e.from);
    else if (e.id.startsWith(VALUE_OF_PREFIX)) defOf.set(e.from, e.to);
  }
  const values = new Map<string, Map<string, { nodeId: string; value: string }>>();
  for (const n of doc.nodes) {
    if (n.absentSince !== undefined || !n.id.startsWith(VALUE_PREFIX)) continue;
    const owner = ownerOf.get(n.id);
    const def = canonical.get(defOf.get(n.id) ?? '');
    if (owner === undefined || def === undefined) continue;
    let m = values.get(owner);
    if (!m) {
      m = new Map();
      values.set(owner, m);
    }
    m.set(def, { nodeId: n.id, value: strField(n.fields, 'FieldValue.value') });
  }
  return { defs, canonical, values };
}

function index(doc: Document): FieldIndex {
  let idx = INDEX_CACHE.get(doc);
  if (!idx) {
    idx = build(doc);
    INDEX_CACHE.set(doc, idx);
  }
  return idx;
}

/** Every live definition for `appliesTo` (all kinds when omitted), by name. */
export function listFieldDefs(doc: Document, appliesTo?: FieldFor): FieldDefView[] {
  return [...index(doc).defs.values()]
    .filter((d) => appliesTo === undefined || d.appliesTo === appliesTo)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function fieldDefById(doc: Document, defId: string): FieldDefView | undefined {
  const idx = index(doc);
  return idx.defs.get(idx.canonical.get(defId) ?? '');
}

/** The stored value of one field on one thing, or undefined when unset. */
export function fieldValue(doc: Document, ownerId: string, defId: string): string | undefined {
  const idx = index(doc);
  return idx.values.get(ownerId)?.get(idx.canonical.get(defId) ?? defId)?.value;
}

export interface FieldRow {
  def: FieldDefView;
  value: string | null;
}

/** Every field that applies to `ownerId`'s kind, with its value or null. */
export function fieldsOf(doc: Document, ownerId: string): FieldRow[] {
  const kind = fieldForOwner(ownerId);
  if (kind === undefined) return [];
  const mine = index(doc).values.get(ownerId);
  return listFieldDefs(doc, kind).map((def) => ({ def, value: mine?.get(def.id)?.value ?? null }));
}

/** Adds a definition; refuses a blank, invalid or already-used name for that kind. */
export function addFieldDef(
  doc: Document,
  fields: { name: string; appliesTo: FieldFor; type: FieldType },
  opts?: Actor,
): { doc: Document; defId: string } {
  const name = normalizeFieldName(fields.name);
  if (!FIELD_FOR.includes(fields.appliesTo) || !FIELD_TYPES.includes(fields.type)) refuse('unknown field kind or type');
  const clash = listFieldDefs(doc, fields.appliesTo).find((d) => foldName(d.name) === foldName(name));
  if (clash) refuse(`a ${fields.appliesTo} field named "${clash.name}" already exists`);

  const { actor, now } = resolve(opts);
  let working = doc;
  const existence = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = existence.doc;
  const defId = formatNodeId('FieldDef', newUlid(now));
  const entries: Record<string, FieldEntry> = {};
  const ops: Op[] = [{ type: 'add_node', node: defId, prov: existence.id }];
  const values: Array<[string, string]> = [
    ['FieldDef.name', name],
    ['FieldDef.applies_to', fields.appliesTo],
    ['FieldDef.value_type', fields.type],
  ];
  for (const [key, value] of values) {
    requireFieldName(key);
    const prov = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = prov.doc;
    entries[key] = { presence: 'set', prov: prov.id, value: key === 'FieldDef.name' ? text(value) : token(value) };
    ops.push({ type: 'set_field', element: defId, key, presence: 'set', prov: prov.id });
  }
  working = withNode(working, { id: defId, existence: existence.id, fields: entries });
  return { doc: withBatch(working, { id: newUlid(now), label: 'add field', ops }), defId };
}

/** Renames a definition's whole duplicate group. A no-op returns `doc` itself. */
export function renameFieldDef(doc: Document, defId: string, rawName: string, opts?: Actor): Document {
  const def = fieldDefById(doc, defId);
  if (!def) throw new UnknownReferenceError(defId, 'a live field definition');
  const name = normalizeFieldName(rawName);
  if (name === def.name) return doc;
  const clash = listFieldDefs(doc, def.appliesTo).find((d) => d.id !== def.id && foldName(d.name) === foldName(name));
  if (clash) refuse(`a ${def.appliesTo} field named "${clash.name}" already exists`);

  const { actor, now } = resolve(opts);
  const idx = index(doc);
  let working = doc;
  const ops: Op[] = [];
  for (const [nodeId, canon] of idx.canonical) {
    if (canon !== def.id) continue;
    const node = findNode(working, nodeId)!;
    const existing = node.fields['FieldDef.name'];
    const prov = assertHand(working, { assertedAt: now, assertedBy: actor, supersedes: existing?.prov });
    working = existing !== undefined ? archiveField(prov.doc, nodeId, 'FieldDef.name', existing) : prov.doc;
    const entry: FieldEntry = { presence: 'set', prov: prov.id, value: text(name) };
    working = replaceNode(working, nodeId, (n) => ({ ...n, fields: { ...n.fields, 'FieldDef.name': entry } }));
    ops.push({ type: 'set_field', element: nodeId, key: 'FieldDef.name', presence: 'set', prov: prov.id });
  }
  return withBatch(working, { id: newUlid(now), label: 'rename field', ops });
}

/** Removes a definition and every value of it, in one undoable batch. */
export function removeFieldDef(doc: Document, defId: string, opts?: Actor): Document {
  const def = fieldDefById(doc, defId);
  if (!def) throw new UnknownReferenceError(defId, 'a live field definition');
  const { actor, now } = resolve(opts);
  const idx = index(doc);
  const defIds = new Set([...idx.canonical].filter(([, c]) => c === def.id).map(([id]) => id));
  const nodeIds = new Set<string>(defIds);
  const edgeIds = new Set<string>();
  for (const id of defIds) for (const e of edgesIn(doc, id, 'ValueOf')) {
    edgeIds.add(e.id);
    nodeIds.add(e.from);
    for (const h of edgesIn(doc, e.from, 'HasFieldValue')) edgeIds.add(h.id);
  }
  const working: Document = {
    ...doc,
    nodes: doc.nodes.map((n) => (nodeIds.has(n.id) ? { ...n, absentSince: now } : n)),
    edges: doc.edges.map((e) => (edgeIds.has(e.id) ? { ...e, absentSince: now } : e)),
  };
  const ops: Op[] = [...nodeIds, ...edgeIds].map((element): Op => ({ type: 'tombstone', element, at: now, by: actor }));
  return withBatch(working, { id: newUlid(now), label: 'remove field', ops });
}

export interface FieldSet {
  ownerId: string;
  defId: string;
  /** Raw text; blank clears the value. */
  raw: string;
}

/**
 * Sets many values in ONE undoable batch (a bulk edit or a paste is one change). Every entry is
 * checked first, so a refusal writes nothing. Returns `doc` itself when nothing changed.
 */
export function setFieldValues(doc: Document, sets: readonly FieldSet[], opts?: Actor): Document {
  const { actor, now } = resolve(opts);
  const idx = index(doc);
  // Last write to the same (owner, field) wins.
  const plan = new Map<string, { ownerId: string; def: FieldDefView; value: string | null }>();
  for (const s of sets) {
    const owner = findNode(doc, s.ownerId);
    if (!owner || owner.absentSince !== undefined) throw new UnknownReferenceError(s.ownerId, 'a live thing');
    const def = fieldDefById(doc, s.defId);
    if (!def) throw new UnknownReferenceError(s.defId, 'a live field definition');
    if (fieldForOwner(s.ownerId) !== def.appliesTo) refuse(`"${def.name}" does not apply to this kind of thing`);
    plan.set(`${s.ownerId}|${def.id}`, { ownerId: s.ownerId, def, value: normalizeFieldValue(def.type, s.raw) });
  }

  let working = doc;
  const ops: Op[] = [];
  const dead = { nodes: new Set<string>(), edges: new Set<string>() };
  for (const { ownerId, def, value } of plan.values()) {
    const current = idx.values.get(ownerId)?.get(def.id);
    if (value === null) {
      if (!current) continue;
      dead.nodes.add(current.nodeId);
      for (const e of edgesIn(doc, current.nodeId, 'HasFieldValue')) dead.edges.add(e.id);
      for (const e of edgesOut(doc, current.nodeId, 'ValueOf')) dead.edges.add(e.id);
    } else if (current) {
      if (current.value === value) continue;
      const node = findNode(working, current.nodeId)!;
      const existing = node.fields['FieldValue.value'];
      const prov = assertHand(working, { assertedAt: now, assertedBy: actor, supersedes: existing?.prov });
      working = existing !== undefined ? archiveField(prov.doc, current.nodeId, 'FieldValue.value', existing) : prov.doc;
      const entry: FieldEntry = { presence: 'set', prov: prov.id, value: text(value) };
      working = replaceNode(working, current.nodeId, (n) => ({ ...n, fields: { ...n.fields, 'FieldValue.value': entry } }));
      ops.push({ type: 'set_field', element: current.nodeId, key: 'FieldValue.value', presence: 'set', prov: prov.id });
    } else {
      const existence = assertHand(working, { assertedAt: now, assertedBy: actor });
      working = existence.doc;
      const valueId = formatNodeId('FieldValue', newUlid(now));
      requireFieldName('FieldValue.value');
      const prov = assertHand(working, { assertedAt: now, assertedBy: actor });
      working = prov.doc;
      working = withNode(working, {
        id: valueId,
        existence: existence.id,
        fields: { 'FieldValue.value': { presence: 'set', prov: prov.id, value: text(value) } },
      });
      ops.push(
        { type: 'add_node', node: valueId, prov: existence.id },
        { type: 'set_field', element: valueId, key: 'FieldValue.value', presence: 'set', prov: prov.id },
      );
      const hasProv = assertHand(working, { assertedAt: now, assertedBy: actor });
      working = hasProv.doc;
      const hasId = formatEdgeId('HasFieldValue', newUlid(now));
      working = withEdge(working, { id: hasId, from: ownerId, to: valueId, prov: hasProv.id, fields: {} });
      const ofProv = assertHand(working, { assertedAt: now, assertedBy: actor });
      working = ofProv.doc;
      const ofId = formatEdgeId('ValueOf', newUlid(now));
      working = withEdge(working, { id: ofId, from: valueId, to: def.id, prov: ofProv.id, fields: {} });
      ops.push(
        { type: 'add_edge', edge: hasId, from: ownerId, to: valueId, prov: hasProv.id },
        { type: 'add_edge', edge: ofId, from: valueId, to: def.id, prov: ofProv.id },
      );
    }
  }
  if (dead.nodes.size > 0) {
    working = {
      ...working,
      nodes: working.nodes.map((n) => (dead.nodes.has(n.id) ? { ...n, absentSince: now } : n)),
      edges: working.edges.map((e) => (dead.edges.has(e.id) ? { ...e, absentSince: now } : e)),
    };
    for (const element of [...dead.nodes, ...dead.edges]) ops.push({ type: 'tombstone', element, at: now, by: actor });
  }
  if (ops.length === 0) return doc;
  const batch: Batch = { id: newUlid(now), label: sets.length > 1 ? 'set fields' : 'set field', ops };
  return withBatch(working, batch);
}

export function setFieldValue(doc: Document, ownerId: string, defId: string, raw: string, opts?: Actor): Document {
  return setFieldValues(doc, [{ ownerId, defId, raw }], opts);
}
