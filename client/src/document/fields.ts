// ADR-0062: a custom field's DEFINITION (name, kind, type, choices) lives in the organisation's
// store (api/fieldDefinitions.ts). Here only VALUES live in the design: a `FieldValue` node owned
// by the thing through `HasFieldValue`, carrying its definition's id. A value whose definition is
// archived or unknown is kept and shown as a removed field, never dropped.
// Shared fields only: a private field needs a per-account store (ADR-0053 §7), which is later.

import {
  LOCAL_ACTOR,
  UnknownReferenceError,
  archiveField,
  assertHand,
  edgesIn,
  findNode,
  formatEdgeId,
  formatNodeId,
  kebab,
  parseNodeId,
  replaceNode,
  requireFieldName,
  text,
  withBatch,
  withEdge,
  withNode,
  type Batch,
  type Document,
  type FieldEntry,
  type NodeKind,
  type Op,
} from './model';
import { FIELD_FOR, FIELD_TYPES, type FieldDefView, type FieldFor, type FieldType } from '../api/fieldDefinitions';
import { newUlid } from './ulid';

export { FIELD_FOR, FIELD_TYPES };
export type { FieldDefView, FieldFor, FieldType };

const VALUE_PREFIX = `${kebab('FieldValue')}:`;
const HAS_VALUE_PREFIX = `${kebab('HasFieldValue')}:`;

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  choice: 'Choice',
  url: 'Link',
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
  if (Array.from(name).length > 100) refuse('a field name must be 100 characters or fewer');
  return name;
}

const MAX_VALUE_LENGTH = 1000;

/** The stored form of `raw` for `def`, or null when blank (a clear). Refuses by name. */
export function normalizeFieldValue(def: Pick<FieldDefView, 'type' | 'choices'>, raw: string): string | null {
  const type = def.type;
  const v = raw.trim();
  if (v === '') return null;
  if (Array.from(v).length > MAX_VALUE_LENGTH) refuse(`a value must be ${MAX_VALUE_LENGTH} characters or fewer`);
  if (/[\p{Cc}\p{Cs}]/u.test(v.replace(/[\n\t]/g, ' '))) refuse('a value must not contain control characters');
  if (type === 'number') {
    if (!/^-?\d+(\.\d+)?$/.test(v)) refuse(`"${v}" is not a number`);
    return v;
  }
  if (type === 'choice') {
    const hit = def.choices.find((c) => c.toLowerCase() === v.toLowerCase());
    if (hit === undefined) refuse(`"${v}" is not one of: ${def.choices.join(', ')}`);
    return hit;
  }
  if (type === 'url') {
    if (!/^https?:\/\/[^\s]+$/i.test(v)) refuse(`"${v}" is not a web link (start with http:// or https://)`);
    return v;
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

interface ValueRef {
  nodeId: string;
  value: string;
}

const INDEX_CACHE = new WeakMap<Document, ReadonlyMap<string, ReadonlyMap<string, ValueRef>>>();

function strField(fields: Readonly<Record<string, FieldEntry>>, key: string): string {
  const e = fields[key];
  return e && e.presence === 'set' && typeof e.value === 'string' ? e.value : '';
}

/** Owner -> definition id -> its live value node and text. */
function index(doc: Document): ReadonlyMap<string, ReadonlyMap<string, ValueRef>> {
  let idx = INDEX_CACHE.get(doc);
  if (idx) return idx;
  const ownerOf = new Map<string, string>();
  for (const e of doc.edges) {
    if (e.absentSince === undefined && e.id.startsWith(HAS_VALUE_PREFIX)) ownerOf.set(e.to, e.from);
  }
  const values = new Map<string, Map<string, ValueRef>>();
  for (const n of doc.nodes) {
    if (n.absentSince !== undefined || !n.id.startsWith(VALUE_PREFIX)) continue;
    const owner = ownerOf.get(n.id);
    const defId = strField(n.fields, 'FieldValue.definition');
    if (owner === undefined || defId === '') continue;
    let m = values.get(owner);
    if (!m) {
      m = new Map();
      values.set(owner, m);
    }
    m.set(defId, { nodeId: n.id, value: strField(n.fields, 'FieldValue.value') });
  }
  idx = values;
  INDEX_CACHE.set(doc, idx);
  return idx;
}

/** Live (not archived) definitions for `appliesTo` (all kinds when omitted), by name. */
export function listFieldDefs(defs: readonly FieldDefView[], appliesTo?: FieldFor): FieldDefView[] {
  return defs
    .filter((d) => !d.archived && (appliesTo === undefined || d.appliesTo === appliesTo))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** The stored value of one field on one thing, or undefined when unset. */
export function fieldValue(doc: Document, ownerId: string, defId: string): string | undefined {
  return index(doc).get(ownerId)?.get(defId)?.value;
}

export interface FieldRow {
  def: FieldDefView;
  value: string | null;
  /** The definition is archived or unknown: shown muted, value kept. */
  removed?: boolean;
}

/** Every live field that applies to `ownerId`'s kind, then values whose definition is gone. */
export function fieldsOf(doc: Document, ownerId: string, defs: readonly FieldDefView[]): FieldRow[] {
  const kind = fieldForOwner(ownerId);
  if (kind === undefined) return [];
  const mine = index(doc).get(ownerId);
  const rows: FieldRow[] = listFieldDefs(defs, kind).map((def) => ({ def, value: mine?.get(def.id)?.value ?? null }));
  if (mine) {
    const live = new Set(rows.map((r) => r.def.id));
    for (const [defId, ref] of mine) {
      if (live.has(defId)) continue;
      const known = defs.find((d) => d.id === defId);
      rows.push({
        def: known ?? { id: defId, appliesTo: kind, name: 'Removed field', type: 'text', choices: [], version: 0, createdBy: '', archived: true },
        value: ref.value,
        removed: true,
      });
    }
  }
  return rows;
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
export function setFieldValues(doc: Document, sets: readonly FieldSet[], defs: readonly FieldDefView[], opts?: Actor): Document {
  const { actor, now } = resolve(opts);
  const idx = index(doc);
  // Last write to the same (owner, field) wins.
  const plan = new Map<string, { ownerId: string; def: FieldDefView; value: string | null }>();
  for (const s of sets) {
    const owner = findNode(doc, s.ownerId);
    if (!owner || owner.absentSince !== undefined) throw new UnknownReferenceError(s.ownerId, 'a live thing');
    const def = defs.find((d) => d.id === s.defId && !d.archived);
    if (!def) throw new UnknownReferenceError(s.defId, 'a live field definition');
    if (fieldForOwner(s.ownerId) !== def.appliesTo) refuse(`"${def.name}" does not apply to this kind of thing`);
    plan.set(`${s.ownerId}|${def.id}`, { ownerId: s.ownerId, def, value: normalizeFieldValue(def, s.raw) });
  }

  let working = doc;
  const ops: Op[] = [];
  const dead = { nodes: new Set<string>(), edges: new Set<string>() };
  for (const { ownerId, def, value } of plan.values()) {
    const current = idx.get(ownerId)?.get(def.id);
    if (value === null) {
      if (!current) continue;
      dead.nodes.add(current.nodeId);
      for (const e of edgesIn(doc, current.nodeId, 'HasFieldValue')) dead.edges.add(e.id);
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
      requireFieldName('FieldValue.definition');
      const valProv = assertHand(working, { assertedAt: now, assertedBy: actor });
      working = valProv.doc;
      const defProv = assertHand(working, { assertedAt: now, assertedBy: actor });
      working = defProv.doc;
      working = withNode(working, {
        id: valueId,
        existence: existence.id,
        fields: {
          'FieldValue.value': { presence: 'set', prov: valProv.id, value: text(value) },
          'FieldValue.definition': { presence: 'set', prov: defProv.id, value: text(def.id) },
        },
      });
      ops.push(
        { type: 'add_node', node: valueId, prov: existence.id },
        { type: 'set_field', element: valueId, key: 'FieldValue.value', presence: 'set', prov: valProv.id },
        { type: 'set_field', element: valueId, key: 'FieldValue.definition', presence: 'set', prov: defProv.id },
      );
      const hasProv = assertHand(working, { assertedAt: now, assertedBy: actor });
      working = hasProv.doc;
      const hasId = formatEdgeId('HasFieldValue', newUlid(now));
      working = withEdge(working, { id: hasId, from: ownerId, to: valueId, prov: hasProv.id, fields: {} });
      ops.push({ type: 'add_edge', edge: hasId, from: ownerId, to: valueId, prov: hasProv.id });
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

export function setFieldValue(doc: Document, ownerId: string, defId: string, raw: string, defs: readonly FieldDefView[], opts?: Actor): Document {
  return setFieldValues(doc, [{ ownerId, defId, raw }], defs, opts);
}
