// One batch as a `fathom-change 1` document (ADR-0063, "Wire"), and applying
// it to a Document. The server applies the same change with
// `fathom_workspace::apply_change`; the two are proved byte for byte against
// Rust-made vectors (`change.vectors.test.ts`).
//
//   fathom-change 1 / schema <version> / (blank) / canonical JSON
//   {"batch": B, "provenance": [P...], "values": [V...]}

import { FIELD_KEYS } from '../../../schema/generated/ir_types';
import { parseCanonical, toCanonicalBytes, type CanonValue } from './canon';
import {
  ACCEPTED_OLDER_SCHEMA_VERSIONS,
  SCHEMA_VERSION,
  batchToJson,
  isArr,
  isObj,
  provenanceToJson,
  readBatch,
  readProvenance,
  req,
} from './plain';
import {
  archiveField,
  findEdge,
  findNode,
  parseEdgeId,
  parseNodeId,
  appendHistory,
  withBatch,
  withEdge,
  withNode,
  withProvenance,
  type Batch,
  type Document,
  type FieldEntry,
  type GraphEdge,
  type GraphNode,
  type ProvenanceRecord,
} from './model';

export const CHANGE_MAGIC = 'fathom-change';
export const CHANGE_FORMAT_VERSION = 1;

export interface Change {
  batch: Batch;
  /** The provenance records `batch` introduces, ascending id. */
  provenance: ProvenanceRecord[];
  /** One value per `set_field` op whose presence is `set`, in op order. */
  values: CanonValue[];
}

export type ChangeErrorReason =
  | 'format'
  | 'not-one-batch'
  | 'unknown-reference'
  | 'duplicate'
  | 'missing-value'
  | 'bad-field';

/** A change that cannot be read or cannot apply to this document. */
export class ChangeError extends Error {
  readonly reason: ChangeErrorReason;
  constructor(reason: ChangeErrorReason, message: string) {
    super(message);
    this.name = 'ChangeError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Wire

const encoder = new TextEncoder();

export function writeChange(change: Change): Uint8Array {
  const header = encoder.encode(`${CHANGE_MAGIC} ${CHANGE_FORMAT_VERSION}\nschema ${SCHEMA_VERSION}\n\n`);
  const body = toCanonicalBytes({
    batch: batchToJson(change.batch),
    provenance: change.provenance.map(provenanceToJson),
    values: change.values,
  });
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

export function readChange(bytes: Uint8Array): Change {
  try {
    const lines: string[] = [];
    let at = 0;
    for (let i = 0; i < 3; i += 1) {
      const nl = bytes.indexOf(0x0a, at);
      if (nl < 0) throw new ChangeError('format', `malformed header at line ${i + 1}`);
      lines.push(new TextDecoder().decode(bytes.subarray(at, nl)));
      at = nl + 1;
    }
    if (lines[0] !== `${CHANGE_MAGIC} ${CHANGE_FORMAT_VERSION}`) throw new ChangeError('format', 'not a fathom-change 1 document');
    if (!lines[1].startsWith('schema ')) throw new ChangeError('format', 'malformed header at line 2');
    const declared = lines[1].slice('schema '.length);
    if (declared !== SCHEMA_VERSION && !ACCEPTED_OLDER_SCHEMA_VERSIONS.includes(declared)) {
      throw new ChangeError('format', `schema version "${declared}" does not match the supported "${SCHEMA_VERSION}"`);
    }
    if (lines[2] !== '') throw new ChangeError('format', 'malformed header at line 3');

    const m = isObj(parseCanonical(bytes.subarray(at)), '$');
    for (const k of Object.keys(m)) {
      if (k !== 'batch' && k !== 'provenance' && k !== 'values') throw new ChangeError('format', `unexpected key "${k}"`);
    }
    return {
      batch: readBatch(req(m, 'batch', '$'), '$.batch'),
      provenance: isArr(req(m, 'provenance', '$'), '$.provenance').map((p, i) => readProvenance(p, `$.provenance[${i}]`)),
      values: isArr(req(m, 'values', '$'), '$.values'),
    };
  } catch (e) {
    if (e instanceof ChangeError) throw e;
    throw new ChangeError('format', e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// Document -> change

function entryIn(doc: Document, element: string, key: string): FieldEntry | undefined {
  return (findNode(doc, element) ?? findEdge(doc, element))?.fields[key];
}

/** The value a `set` op wrote: the live entry when it is still that write,
 * else the archived one. */
function valueOfWrite(after: Document, element: string, key: string, prov: string): CanonValue {
  const live = entryIn(after, element, key);
  if (live !== undefined && live.prov === prov && live.value !== undefined) return live.value;
  const archived = after.history
    .find((h) => h.element === element && h.field === key)
    ?.entries.find((e) => e.prov === prov);
  if (archived?.value !== undefined) return archived.value;
  throw new ChangeError('missing-value', `no value for ${key} on ${element}`);
}

/** A record as it travels: `supersedes` is the store's to fill (`graph.rs`'s `check_prov`). */
export function onTheWire(p: ProvenanceRecord): ProvenanceRecord {
  return { ...p, supersedes: undefined };
}

/** The changes that turn `before` into `after`, one per appended batch, each
 * carrying exactly the provenance its ops name. */
export function changesOf(before: Document, after: Document): Change[] {
  const n = before.batches.length;
  if (after.batches.length <= n) throw new ChangeError('not-one-batch', 'the document gained no batch');
  const known = new Set(before.provenance.map((p) => p.id));
  const fresh = after.provenance.filter((p) => !known.has(p.id));
  const claimed = new Set<string>();
  const out: Change[] = [];
  for (let i = n; i < after.batches.length; i += 1) {
    const batch = after.batches[i];
    const named = new Set<string>();
    for (const op of batch.ops) if ('prov' in op) named.add(op.prov);
    const mine = fresh.filter((p) => named.has(p.id) && !claimed.has(p.id));
    mine.forEach((p) => claimed.add(p.id));
    const values: CanonValue[] = [];
    for (const op of batch.ops) {
      if (op.type === 'set_field' && op.presence === 'set') values.push(valueOfWrite(after, op.element, op.key, op.prov));
    }
    out.push({ batch, provenance: mine.map(onTheWire), values });
  }
  return out;
}

/** The one change that turns `before` into `after`, which gained exactly one batch. */
export function changeOf(before: Document, after: Document): Change {
  if (after.batches.length !== before.batches.length + 1) {
    throw new ChangeError('not-one-batch', 'the document did not gain exactly one batch');
  }
  return changesOf(before, after)[0];
}

// ---------------------------------------------------------------------------
// Apply

function unknown(id: string, what: string): ChangeError {
  return new ChangeError('unknown-reference', `${what} "${id}" is not in this document`);
}

function replaceFields(doc: Document, element: string, fields: Record<string, FieldEntry>): Document {
  if (findNode(doc, element)) {
    return { ...doc, nodes: doc.nodes.map((n) => (n.id === element ? { ...n, fields } : n)) };
  }
  return { ...doc, edges: doc.edges.map((e) => (e.id === element ? { ...e, fields } : e)) };
}

function setAbsent(doc: Document, element: string, at: number | undefined): Document {
  if (findNode(doc, element)) {
    return { ...doc, nodes: doc.nodes.map((n) => (n.id === element ? { ...n, absentSince: at } : n)) };
  }
  return { ...doc, edges: doc.edges.map((e) => (e.id === element ? { ...e, absentSince: at } : e)) };
}

/** Applies `change` to `doc`: what the command that made it did. Throws a
 * `ChangeError` and returns nothing when an op cannot apply; `doc` is never
 * altered. */
export function applyChange(doc: Document, change: Change): Document {
  const { batch } = change;
  if (doc.batches.some((b) => b.id === batch.id)) throw new ChangeError('duplicate', `batch "${batch.id}" is already in this document`);

  let d = doc;
  const known = new Set(doc.provenance.map((p) => p.id));
  const introduced = new Map<string, ProvenanceRecord>();
  for (const p of change.provenance) {
    if (known.has(p.id) || introduced.has(p.id)) throw new ChangeError('duplicate', `provenance "${p.id}" is already in this document`);
    introduced.set(p.id, p);
  }
  const named = new Set<string>();
  for (const op of batch.ops) if ('prov' in op) named.add(op.prov);
  if (named.size !== introduced.size || [...named].some((id) => !introduced.has(id))) {
    throw new ChangeError('unknown-reference', 'the change does not carry exactly the provenance its ops name');
  }
  // Interns the record an op names, `supersedes` filled with what the field held (`check_prov`).
  const intern = (id: string, current: string | undefined): void => {
    const rec = introduced.get(id)!;
    if (!known.has(id)) {
      known.add(id);
      d = withProvenance(d, { ...rec, supersedes: current });
    }
  };

  let next = 0;
  for (const op of batch.ops) {
    switch (op.type) {
      case 'add_node': {
        try {
          parseNodeId(op.node);
        } catch (e) {
          throw new ChangeError('unknown-reference', e instanceof Error ? e.message : String(e));
        }
        if (findNode(d, op.node)) throw new ChangeError('duplicate', `node "${op.node}" is already in this document`);
        intern(op.prov, undefined);
        const node: GraphNode = { id: op.node, existence: op.prov, fields: {} };
        d = withNode(d, node);
        break;
      }
      case 'add_edge': {
        try {
          parseEdgeId(op.edge);
        } catch (e) {
          throw new ChangeError('unknown-reference', e instanceof Error ? e.message : String(e));
        }
        if (findEdge(d, op.edge)) throw new ChangeError('duplicate', `edge "${op.edge}" is already in this document`);
        if (!findNode(d, op.from)) throw unknown(op.from, 'node');
        if (!findNode(d, op.to)) throw unknown(op.to, 'node');
        intern(op.prov, undefined);
        const edge: GraphEdge = { id: op.edge, from: op.from, to: op.to, prov: op.prov, fields: {} };
        d = withEdge(d, edge);
        break;
      }
      case 'set_field': {
        if (!Object.hasOwn(FIELD_KEYS, op.key)) throw new ChangeError('bad-field', `field "${op.key}" is not in the schema's field registry`);
        const holder = findNode(d, op.element) ?? findEdge(d, op.element);
        if (!holder) throw unknown(op.element, 'element');
        const existing = holder.fields[op.key];
        intern(op.prov, existing?.prov);
        let entry: FieldEntry | undefined;
        if (op.presence === 'set') {
          if (next >= change.values.length) throw new ChangeError('missing-value', `no value for ${op.key} on ${op.element}`);
          entry = { presence: 'set', prov: op.prov, value: change.values[next] };
          next += 1;
        } else if (op.presence === 'absent') {
          entry = { presence: 'absent', prov: op.prov };
        }
        if (existing !== undefined) d = archiveField(d, op.element, op.key, existing);
        const fields: Record<string, FieldEntry> = { ...holder.fields };
        if (entry) {
          fields[op.key] = entry;
        } else {
          delete fields[op.key];
          d = appendHistory(d, op.element, op.key, { presence: 'unknown', prov: op.prov });
        }
        d = replaceFields(d, op.element, fields);
        break;
      }
      case 'tombstone':
        if (!findNode(d, op.element) && !findEdge(d, op.element)) throw unknown(op.element, 'element');
        d = setAbsent(d, op.element, op.at);
        break;
      case 'revive':
        if (!findNode(d, op.element) && !findEdge(d, op.element)) throw unknown(op.element, 'element');
        d = setAbsent(d, op.element, undefined);
        break;
    }
  }
  if (next !== change.values.length) throw new ChangeError('missing-value', 'the change carries more values than set ops');
  return withBatch(d, batch);
}
