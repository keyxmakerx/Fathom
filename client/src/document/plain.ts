// The plain face reader and writer — the browser side of
// `crates/fathom-workspace/src/lib.rs`'s `read_plain` / `write_plain`. Format,
// in five lines:
//
//   line 1   fathom-plain 1
//   line 2   THIS FILE IS PLAINTEXT. EVERY PROTECTION THE WORKSPACE HAS ENDS HERE.
//   line 3   schema <SCHEMA_VERSION>
//   line 4   (empty)
//   line 5   <the snapshot as canonical JSON, one line, ending in the final LF>
//
// ADR-0049: this is the one graph format the Rust engine reads, and the
// server reads every payload back through `read_plain` before storing it —
// this module's writer only has to produce bytes that reader accepts, not
// police the graph's own shape (L0 arity, dangling provenance, tombstone
// cascades) itself. That is the referee's job, deliberately not duplicated
// here (never reimplement a gate the format already has one for).
//
import { toCanonicalBytes, parseCanonical, type CanonValue } from './canon';
import { SCHEMA_VERSION, type NodeKind, type EdgeKind } from '../../../schema/generated/ir_types';
import {
  compareEdgeId,
  compareHistoryRecord,
  compareNodeId,
  isNodeId,
  parseNodeId,
  parseEdgeId,
  type Batch,
  type Document,
  type FieldEntry,
  type FieldPresence,
  type GraphEdge,
  type GraphNode,
  type HistoryEntry,
  type HistoryRecord,
  type Op,
  type Origin,
  type ProvenanceRecord,
} from './model';

export const PLAIN_MAGIC = 'fathom-plain';
export const PLAIN_FACE_VERSION = 1;
export const PLAIN_WARNING =
  'THIS FILE IS PLAINTEXT. EVERY PROTECTION THE WORKSPACE HAS ENDS HERE.';
export { SCHEMA_VERSION };

// Every 0.10-to-0.18 move is additive, so a payload declared at an older
// version reads exactly like a current one. Every older version this reader
// still opens, and no other -- byte-identical to
// `fathom_workspace::ACCEPTED_OLDER_SCHEMA_VERSIONS`.
export const ACCEPTED_OLDER_SCHEMA_VERSIONS: readonly string[] = ['0.10', '0.11', '0.12', '0.13', '0.14', '0.15', '0.16', '0.17'];

// Kinds 0.11 (ADR-0058) added. A payload declared at 0.10 cannot
// legitimately hold one -- its editor never had the kind -- so finding one
// is a sign the header is lying, not a design to open. Mirrors
// `fathom_workspace::{NODE_KINDS_SINCE_0_11, EDGE_KINDS_SINCE_0_11}`.
const NODE_KINDS_SINCE_0_11: ReadonlySet<NodeKind> = new Set(['ContainerNetwork', 'Container', 'PublishedPort']);
const EDGE_KINDS_SINCE_0_11: ReadonlySet<EdgeKind> = new Set([
  'HasContainerNetwork',
  'HasContainer',
  'HasPublishedPort',
  'AttachedTo',
  'ParentUnit',
]);

// Kinds 0.12 (ADR-0059) added. A payload declared at 0.10 or 0.11 cannot
// legitimately hold one, `NODE_KINDS_SINCE_0_11`'s own reasoning. Mirrors
// `fathom_workspace::{NODE_KINDS_SINCE_0_12, EDGE_KINDS_SINCE_0_12}`.
const NODE_KINDS_SINCE_0_12: ReadonlySet<NodeKind> = new Set(['Tag']);
const EDGE_KINDS_SINCE_0_12: ReadonlySet<EdgeKind> = new Set(['HasTag', 'TaggedWith']);

// Kinds 0.13 (ADR-0060 step 7) added; same reasoning, for 0.10 to 0.12.
const NODE_KINDS_SINCE_0_13: ReadonlySet<NodeKind> = new Set(['Label', 'Line']);
const EDGE_KINDS_SINCE_0_13: ReadonlySet<EdgeKind> = new Set(['HasLabel', 'HasLine', 'LineEnd']);

// Kinds 0.14 (ADR-0061 round 7, docs) added; same reasoning, for 0.10 to 0.13.
const NODE_KINDS_SINCE_0_14: ReadonlySet<NodeKind> = new Set(['Doc', 'DocLink', 'DocFile']);
const EDGE_KINDS_SINCE_0_14: ReadonlySet<EdgeKind> = new Set(['HasDoc', 'DocOn', 'HasDocLink', 'HasDocFile']);

// Kinds 0.15 (ADR-0061 round 7, maintenance plans) added; same reasoning, for 0.10 to 0.14.
const NODE_KINDS_SINCE_0_15: ReadonlySet<NodeKind> = new Set(['MaintenancePlan', 'PlanStep']);
const EDGE_KINDS_SINCE_0_15: ReadonlySet<EdgeKind> = new Set(['HasPlan', 'HasStep']);

// Kinds 0.16 (custom-field values) added; same reasoning, for 0.10 to 0.15.
const NODE_KINDS_SINCE_0_16: ReadonlySet<NodeKind> = new Set(['FieldValue']);
const EDGE_KINDS_SINCE_0_16: ReadonlySet<EdgeKind> = new Set(['HasFieldValue']);

// Kinds 0.18 (ADR-0061 troubleshooting) added; every accepted older header is too old for them.
const NODE_KINDS_SINCE_0_18: ReadonlySet<NodeKind> = new Set(['Issue', 'IssueStep']);
const EDGE_KINDS_SINCE_0_18: ReadonlySet<EdgeKind> = new Set(['HasIssue', 'HasIssueStep']);

// A kind first added at minor `m` is too new for any header below `m`. Mirrors the Rust table.
const NODES_SINCE: ReadonlyArray<readonly [number, ReadonlySet<NodeKind>]> = [
  [11, NODE_KINDS_SINCE_0_11],
  [12, NODE_KINDS_SINCE_0_12],
  [13, NODE_KINDS_SINCE_0_13],
  [14, NODE_KINDS_SINCE_0_14],
  [15, NODE_KINDS_SINCE_0_15],
  [16, NODE_KINDS_SINCE_0_16],
  [18, NODE_KINDS_SINCE_0_18],
];
const EDGES_SINCE: ReadonlyArray<readonly [number, ReadonlySet<EdgeKind>]> = [
  [11, EDGE_KINDS_SINCE_0_11],
  [12, EDGE_KINDS_SINCE_0_12],
  [13, EDGE_KINDS_SINCE_0_13],
  [14, EDGE_KINDS_SINCE_0_14],
  [15, EDGE_KINDS_SINCE_0_15],
  [16, EDGE_KINDS_SINCE_0_16],
  [18, EDGE_KINDS_SINCE_0_18],
];

function rejectKindsTooNewForDeclaredVersion(declared: string, doc: Document): void {
  // Nothing to check for the current version (everything is legitimate
  // there) or any value the version check above this call already refused.
  if (!ACCEPTED_OLDER_SCHEMA_VERSIONS.includes(declared)) return;
  const minor = Number.parseInt(declared.slice(2), 10);
  for (const n of doc.nodes) {
    const kind = parseNodeId(n.id).kind;
    if (NODES_SINCE.some(([since, kinds]) => minor < since && kinds.has(kind))) {
      throw new PlainError({ kind: 'kind-not-in-declared-version', declaredVersion: declared, elementKind: kind });
    }
  }
  for (const e of doc.edges) {
    const kind = parseEdgeId(e.id).kind;
    if (EDGES_SINCE.some(([since, kinds]) => minor < since && kinds.has(kind))) {
      throw new PlainError({ kind: 'kind-not-in-declared-version', declaredVersion: declared, elementKind: kind });
    }
  }
}

export type PlainErrorReason =
  | { kind: 'not-plain-face' }
  | { kind: 'unsupported-face-version'; found: string }
  | { kind: 'missing-plaintext-banner' }
  | { kind: 'schema-version-mismatch'; found: string; supported: string }
  /** A declared older version's editor never had this kind (ADR-0058
   * decision 6) -- distinct from `schema-version-mismatch`, which is about
   * the header's version token itself, not what it holds. */
  | { kind: 'kind-not-in-declared-version'; declaredVersion: string; elementKind: string }
  | { kind: 'malformed-header'; line: number }
  | { kind: 'json'; message: string }
  | { kind: 'shape'; path: string; expected: string };

export class PlainError extends Error {
  readonly reason: PlainErrorReason;
  constructor(reason: PlainErrorReason) {
    super(plainErrorMessage(reason));
    this.name = 'PlainError';
    this.reason = reason;
  }
}

function plainErrorMessage(r: PlainErrorReason): string {
  switch (r.kind) {
    case 'not-plain-face':
      return 'not a fathom-plain file';
    case 'unsupported-face-version':
      return `unsupported plain face version "${r.found}"`;
    case 'missing-plaintext-banner':
      return 'line 2 is not the plaintext banner, verbatim';
    case 'schema-version-mismatch':
      return `schema version "${r.found}" does not match the supported "${r.supported}"`;
    case 'kind-not-in-declared-version':
      return `${r.elementKind} does not exist in schema ${r.declaredVersion}`;
    case 'malformed-header':
      return `malformed header at line ${r.line}`;
    case 'json':
      return `canonical JSON: ${r.message}`;
    case 'shape':
      return `${r.path}: expected ${r.expected}`;
  }
}

export function shapeErr(path: string, expected: string): PlainError {
  return new PlainError({ kind: 'shape', path, expected });
}

// ---------------------------------------------------------------------------
// Write

export function writePlain(doc: Document): Uint8Array {
  const encoder = new TextEncoder();
  const header = encoder.encode(
    `${PLAIN_MAGIC} ${PLAIN_FACE_VERSION}\n${PLAIN_WARNING}\nschema ${SCHEMA_VERSION}\n\n`,
  );
  const body = toCanonicalBytes(documentToJson(doc));
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

// ---------------------------------------------------------------------------
// Delta — `fathom_workspace::write_delta`'s format: the batches a holder has not seen, and the
// state they need to be applied (the ops carry no values). Four header lines, then the plain
// face's own snapshot object holding only that fragment:
//
//   fathom-delta 1
//   schema <SCHEMA_VERSION>
//   base <ulid of the last batch the holder has | none>
//   (empty)
//   <fragment as canonical JSON>
//
// Only the batches are instructions; the nodes, edges, provenance and history are evidence the
// module checks against them (`fathom-graph/src/sync.rs`). A fragment that is short or wrong is
// refused there, not repaired here.

export const DELTA_MAGIC = 'fathom-delta';
export const DELTA_FACE_VERSION = 1;

function findSorted<T>(arr: readonly T[], compare: (x: T) => number): T | undefined {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = compare(arr[mid]);
    if (c === 0) return arr[mid];
    if (c < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/** The delta for a holder of `doc.batches[0..held]`: the rest of the log and what it touched.
 * The caller has checked that `held` batches are a prefix of `doc.batches`. */
export function writeDelta(doc: Document, held: number): Uint8Array {
  const batches = doc.batches.slice(held);
  const elements = new Set<string>();
  const provs = new Set<string>();
  const sets = new Map<string, { element: string; field: string }>();
  for (const batch of batches) {
    for (const op of batch.ops) {
      switch (op.type) {
        case 'add_node':
          elements.add(op.node);
          provs.add(op.prov);
          break;
        case 'add_edge':
          elements.add(op.edge);
          provs.add(op.prov);
          break;
        case 'set_field':
          elements.add(op.element);
          provs.add(op.prov);
          sets.set(`${op.element}\u0000${op.key}`, { element: op.element, field: op.key });
          break;
        case 'tombstone':
        case 'revive':
          elements.add(op.element);
          break;
      }
    }
  }
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const id of elements) {
    if (isNodeId(id)) {
      const n = findSorted(doc.nodes, (x) => compareNodeId(x.id, id));
      if (n) nodes.push(n);
    } else {
      const e = findSorted(doc.edges, (x) => compareEdgeId(x.id, id));
      if (e) edges.push(e);
    }
  }
  const provenance: ProvenanceRecord[] = [];
  for (const id of provs) {
    const p = findSorted(doc.provenance, (x) => (x.id < id ? -1 : x.id > id ? 1 : 0));
    if (p) provenance.push(p);
  }
  const history: HistoryRecord[] = [];
  for (const s of sets.values()) {
    const h = findSorted(doc.history, (x) => compareHistoryRecord(x, s));
    if (h) history.push(h);
  }
  const base = held > 0 ? doc.batches[held - 1].id : 'none';
  const header = new TextEncoder().encode(
    `${DELTA_MAGIC} ${DELTA_FACE_VERSION}\nschema ${SCHEMA_VERSION}\nbase ${base}\n\n`,
  );
  const body = toCanonicalBytes({
    batches: batches.map(batchToJson),
    edges: edges.map(edgeToJson),
    history: history.map(historyToJson),
    nodes: nodes.map(nodeToJson),
    provenance: provenance.map(provenanceToJson),
  });
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

// ---------------------------------------------------------------------------
// Read

export function readPlain(bytes: Uint8Array): Document {
  const magicPrefix = new TextEncoder().encode(`${PLAIN_MAGIC} `);
  if (!startsWith(bytes, magicPrefix)) {
    throw new PlainError({ kind: 'not-plain-face' });
  }

  const [header, body] = splitHeader(bytes);
  const decoder = new TextDecoder('utf-8', { fatal: false });

  const version = decoder.decode(header[0].subarray(magicPrefix.length));
  if (version !== String(PLAIN_FACE_VERSION)) {
    throw new PlainError({ kind: 'unsupported-face-version', found: version });
  }

  if (!bytesEqual(header[1], new TextEncoder().encode(PLAIN_WARNING))) {
    throw new PlainError({ kind: 'missing-plaintext-banner' });
  }

  const line3 = decoder.decode(header[2]);
  if (!line3.startsWith('schema ')) {
    throw new PlainError({ kind: 'malformed-header', line: 3 });
  }
  const declared = line3.slice('schema '.length);
  if (declared !== SCHEMA_VERSION && !ACCEPTED_OLDER_SCHEMA_VERSIONS.includes(declared)) {
    throw new PlainError({
      kind: 'schema-version-mismatch',
      found: declared,
      supported: SCHEMA_VERSION,
    });
  }

  if (header[3].length !== 0) {
    throw new PlainError({ kind: 'malformed-header', line: 4 });
  }

  let json: CanonValue;
  try {
    json = parseCanonical(body);
  } catch (e) {
    throw new PlainError({ kind: 'json', message: e instanceof Error ? e.message : String(e) });
  }
  const doc = jsonToDocument(json);
  rejectKindsTooNewForDeclaredVersion(declared, doc);
  return doc;
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** The four header lines and the body that follows them, byte for byte —
 * `fathom-workspace::split_header`'s exact rule. */
function splitHeader(bytes: Uint8Array): [Uint8Array[], Uint8Array] {
  const lines: Uint8Array[] = [];
  let at = 0;
  for (let i = 0; i < 4; i += 1) {
    const nl = bytes.indexOf(0x0a, at);
    if (nl < 0) {
      throw new PlainError({ kind: 'malformed-header', line: i + 1 });
    }
    lines.push(bytes.subarray(at, nl));
    at = nl + 1;
  }
  return [lines, bytes.subarray(at)];
}

// ---------------------------------------------------------------------------
// Document <-> canonical JSON. Mirrors `fathom-workspace`'s
// `snapshot_to_json` / `snapshot_from_json` key for key; see that file for
// the wire shape this must match exactly.

function fieldsToJson(fields: Readonly<Record<string, FieldEntry>>): CanonValue {
  const out: { [key: string]: CanonValue } = {};
  for (const [name, entry] of Object.entries(fields)) {
    const e: { [key: string]: CanonValue } = { presence: entry.presence, prov: entry.prov };
    if (entry.value !== undefined) e.value = entry.value;
    out[name] = e;
  }
  return out;
}

function nodeToJson(n: GraphNode): CanonValue {
  const out: { [key: string]: CanonValue } = {
    existence: n.existence,
    fields: fieldsToJson(n.fields),
    id: n.id,
  };
  if (n.absentSince !== undefined) out.absent_since = n.absentSince;
  return out;
}

function edgeToJson(e: GraphEdge): CanonValue {
  const out: { [key: string]: CanonValue } = {
    fields: fieldsToJson(e.fields),
    from: e.from,
    id: e.id,
    prov: e.prov,
    to: e.to,
  };
  if (e.absentSince !== undefined) out.absent_since = e.absentSince;
  return out;
}

function originToJson(o: Origin): CanonValue {
  if (o.kind === 'hand') return 'hand';
  return {
    parsed: {
      capture: o.capture,
      span: { end: o.span.end, start: o.span.start },
    },
  };
}

export function provenanceToJson(r: ProvenanceRecord): CanonValue {
  const out: { [key: string]: CanonValue } = {
    asserted_at: r.assertedAt,
    asserted_by: { user: r.assertedBy },
    confidence: r.confidence,
    id: r.id,
    origin: originToJson(r.origin),
  };
  if (r.supersedes !== undefined) out.supersedes = r.supersedes;
  return out;
}

function historyEntryToJson(e: HistoryEntry): CanonValue {
  const out: { [key: string]: CanonValue } = { presence: e.presence, prov: e.prov };
  if (e.value !== undefined) out.value = e.value;
  return out;
}

function historyToJson(h: HistoryRecord): CanonValue {
  return {
    element: h.element,
    entries: h.entries.map(historyEntryToJson),
    field: h.field,
    truncated: h.truncated,
  };
}

function opToJson(op: Op): CanonValue {
  switch (op.type) {
    case 'add_node':
      return { add_node: { node: op.node, prov: op.prov } };
    case 'add_edge':
      return { add_edge: { edge: op.edge, from: op.from, prov: op.prov, to: op.to } };
    case 'set_field':
      return {
        set_field: { element: op.element, key: op.key, presence: op.presence, prov: op.prov },
      };
    case 'tombstone':
      return { tombstone: { at: op.at, by: op.by, element: op.element } };
    case 'revive':
      return { revive: { at: op.at, by: op.by, element: op.element } };
  }
}

export function batchToJson(b: Batch): CanonValue {
  const out: { [key: string]: CanonValue } = { id: b.id, label: b.label, ops: b.ops.map(opToJson) };
  // ADR-0053 §4: both optional, written only when present.
  if (b.comment !== undefined) out.comment = b.comment;
  if (b.reverses !== undefined) out.reverses = b.reverses;
  return out;
}

function documentToJson(doc: Document): CanonValue {
  return {
    batches: doc.batches.map(batchToJson),
    edges: doc.edges.map(edgeToJson),
    history: doc.history.map(historyToJson),
    nodes: doc.nodes.map(nodeToJson),
    provenance: doc.provenance.map(provenanceToJson),
  };
}

// ---------------------------------------------------------------------------
// canonical JSON -> Document

export function isObj(v: CanonValue, path: string): { [key: string]: CanonValue } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw shapeErr(path, 'a JSON object');
  }
  return v;
}

export function isArr(v: CanonValue, path: string): CanonValue[] {
  if (!Array.isArray(v)) throw shapeErr(path, 'a JSON array');
  return v;
}

function isStr(v: CanonValue, path: string): string {
  if (typeof v !== 'string') throw shapeErr(path, 'a JSON string');
  return v;
}

function isNum(v: CanonValue, path: string): number {
  if (typeof v !== 'number') throw shapeErr(path, 'a JSON integer');
  return v;
}

export function req(m: { [key: string]: CanonValue }, key: string, path: string): CanonValue {
  if (!(key in m)) throw shapeErr(`${path}.${key}`, 'a required key');
  return m[key];
}

function readFields(v: CanonValue, path: string): Record<string, FieldEntry> {
  const m = isObj(v, path);
  const out: Record<string, FieldEntry> = {};
  for (const [name, entryJson] of Object.entries(m)) {
    const here = `${path}.${name}`;
    const e = isObj(entryJson, here);
    const presence = isStr(req(e, 'presence', here), `${here}.presence`);
    if (presence !== 'set' && presence !== 'absent' && presence !== 'unknown') {
      throw shapeErr(`${here}.presence`, 'one of set / absent / unknown');
    }
    const prov = isStr(req(e, 'prov', here), `${here}.prov`);
    out[name] = {
      presence: presence as FieldPresence,
      prov,
      value: 'value' in e ? e.value : undefined,
    };
  }
  return out;
}

function readAbsentSince(m: { [key: string]: CanonValue }, path: string): number | undefined {
  if (!('absent_since' in m)) return undefined;
  return isNum(m.absent_since, `${path}.absent_since`);
}

function readNode(v: CanonValue, path: string): GraphNode {
  const m = isObj(v, path);
  return {
    id: isStr(req(m, 'id', path), `${path}.id`),
    existence: isStr(req(m, 'existence', path), `${path}.existence`),
    absentSince: readAbsentSince(m, path),
    fields: readFields(req(m, 'fields', path), `${path}.fields`),
  };
}

function readEdge(v: CanonValue, path: string): GraphEdge {
  const m = isObj(v, path);
  return {
    id: isStr(req(m, 'id', path), `${path}.id`),
    from: isStr(req(m, 'from', path), `${path}.from`),
    to: isStr(req(m, 'to', path), `${path}.to`),
    prov: isStr(req(m, 'prov', path), `${path}.prov`),
    absentSince: readAbsentSince(m, path),
    fields: readFields(req(m, 'fields', path), `${path}.fields`),
  };
}

function readOrigin(v: CanonValue, path: string): Origin {
  if (typeof v === 'string') {
    if (v === 'hand') return { kind: 'hand' };
    throw shapeErr(path, 'one of the origins hand / parsed');
  }
  const m = isObj(v, path);
  if (!('parsed' in m) || Object.keys(m).length !== 1) {
    throw shapeErr(path, 'a one-key origin object');
  }
  const payload = isObj(m.parsed, path);
  const span = isObj(req(payload, 'span', path), path);
  return {
    kind: 'parsed',
    capture: isStr(req(payload, 'capture', path), path),
    span: {
      start: isNum(req(span, 'start', path), path),
      end: isNum(req(span, 'end', path), path),
    },
  };
}

export function readProvenance(v: CanonValue, path: string): ProvenanceRecord {
  const m = isObj(v, path);
  const actor = isObj(req(m, 'asserted_by', path), path);
  if (!('user' in actor) || Object.keys(actor).length !== 1) {
    throw shapeErr(path, 'an actor object with a `user` key');
  }
  const confidence = isStr(req(m, 'confidence', path), path);
  if (confidence !== 'asserted' && confidence !== 'derived' && confidence !== 'heuristic') {
    throw shapeErr(path, 'one of asserted / derived / heuristic');
  }
  return {
    id: isStr(req(m, 'id', path), path),
    origin: readOrigin(req(m, 'origin', path), path),
    assertedAt: isNum(req(m, 'asserted_at', path), path),
    assertedBy: isStr(actor.user, path),
    confidence,
    supersedes: 'supersedes' in m ? isStr(m.supersedes, path) : undefined,
  };
}

function readHistoryEntry(v: CanonValue, path: string): HistoryEntry {
  const m = isObj(v, path);
  const presence = isStr(req(m, 'presence', path), path);
  if (presence !== 'set' && presence !== 'absent' && presence !== 'unknown') {
    throw shapeErr(path, 'one of set / absent / unknown');
  }
  return { presence, prov: isStr(req(m, 'prov', path), path), value: 'value' in m ? m.value : undefined };
}

function readHistory(v: CanonValue, path: string): HistoryRecord {
  const m = isObj(v, path);
  const entries = isArr(req(m, 'entries', path), `${path}.entries`).map((e, i) =>
    readHistoryEntry(e, `${path}.entries[${i}]`),
  );
  return {
    element: isStr(req(m, 'element', path), path),
    field: isStr(req(m, 'field', path), path),
    entries,
    truncated: isNum(req(m, 'truncated', path), path),
  };
}

function readOp(v: CanonValue, path: string): Op {
  const m = isObj(v, path);
  const keys = Object.keys(m);
  if (keys.length !== 1) throw shapeErr(path, 'a one-key op object');
  const tag = keys[0];
  const p = isObj(m[tag], path);
  switch (tag) {
    case 'add_node':
      return { type: 'add_node', node: isStr(req(p, 'node', path), path), prov: isStr(req(p, 'prov', path), path) };
    case 'add_edge':
      return {
        type: 'add_edge',
        edge: isStr(req(p, 'edge', path), path),
        from: isStr(req(p, 'from', path), path),
        to: isStr(req(p, 'to', path), path),
        prov: isStr(req(p, 'prov', path), path),
      };
    case 'set_field': {
      const presence = isStr(req(p, 'presence', path), path);
      if (presence !== 'set' && presence !== 'absent' && presence !== 'unknown') {
        throw shapeErr(path, 'one of set / absent / unknown');
      }
      return {
        type: 'set_field',
        element: isStr(req(p, 'element', path), path),
        key: isStr(req(p, 'key', path), path),
        presence,
        prov: isStr(req(p, 'prov', path), path),
      };
    }
    case 'tombstone':
      return {
        type: 'tombstone',
        element: isStr(req(p, 'element', path), path),
        at: isNum(req(p, 'at', path), path),
        by: isStr(req(p, 'by', path), path),
      };
    case 'revive':
      return {
        type: 'revive',
        element: isStr(req(p, 'element', path), path),
        at: isNum(req(p, 'at', path), path),
        by: isStr(req(p, 'by', path), path),
      };
    default:
      throw shapeErr(path, 'one of the five op tags');
  }
}

export function readBatch(v: CanonValue, path: string): Batch {
  const m = isObj(v, path);
  const ops = isArr(req(m, 'ops', path), `${path}.ops`).map((o, i) => readOp(o, `${path}.ops[${i}]`));
  const batch: Batch = { id: isStr(req(m, 'id', path), path), label: isStr(req(m, 'label', path), path), ops };
  if ('comment' in m) batch.comment = isStr(m.comment, `${path}.comment`);
  if ('reverses' in m) batch.reverses = isStr(m.reverses, `${path}.reverses`);
  return batch;
}

function jsonToDocument(v: CanonValue): Document {
  const m = isObj(v, '$');
  for (const k of Object.keys(m)) {
    if (!['batches', 'edges', 'history', 'nodes', 'provenance'].includes(k)) {
      throw shapeErr('$', 'only the five declared top-level keys');
    }
  }
  const nodes = isArr(req(m, 'nodes', '$'), '$.nodes').map((n, i) => readNode(n, `$.nodes[${i}]`));
  const edges = isArr(req(m, 'edges', '$'), '$.edges').map((e, i) => readEdge(e, `$.edges[${i}]`));
  const provenance = isArr(req(m, 'provenance', '$'), '$.provenance').map((p, i) =>
    readProvenance(p, `$.provenance[${i}]`),
  );
  const history = isArr(req(m, 'history', '$'), '$.history').map((h, i) => readHistory(h, `$.history[${i}]`));
  const batches = isArr(req(m, 'batches', '$'), '$.batches').map((b, i) => readBatch(b, `$.batches[${i}]`));
  return { nodes, edges, provenance, history, batches };
}
