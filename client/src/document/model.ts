// The in-memory graph: a near-literal mirror of `fathom-graph`'s `Snapshot`
// (`crates/fathom-graph/src/snap.rs`) so `plain.ts` can read and write it
// without lossy translation, plus typed field readers/writers for the five
// kinds and four edges this session draws — `Premises`, `Rack`, `Device`,
// `Chassis`, `PhysicalPort`; `HasRack`, `HasChassis`, `MountedIn`, `HasPort`.
//
// A node or edge of any OTHER declared kind is carried unchanged: its
// `fields` are opaque `FieldEntry` records keyed by the same wire name
// `fathom-workspace`'s `field_name` writes, never interpreted, never
// dropped. Nothing here invents a field; every wire name used below is
// checked at the field registry, `schema/generated/ir_types.ts`'s
// `FIELD_KEYS` (CLAUDE.md rule 3).

import { FIELD_KEYS, NODE_KINDS, EDGE_KINDS, type NodeKind, type EdgeKind } from '../../../schema/generated/ir_types';
import type { CanonValue } from './canon';
import { canonicalUlid, newUlid } from './ulid';

// ---------------------------------------------------------------------------
// Ids: `<kebab-kind>:<ulid>`, `.context/conventions.md`'s spelling, mirrored
// from `crates/fathom-graph/src/id.rs`.

/** `CamelCase` -> `kebab-case`, byte-identical to `fathom-graph::id::kebab`. */
export function kebab(name: string): string {
  let out = '';
  for (let i = 0; i < name.length; i += 1) {
    const c = name[i];
    if (c >= 'A' && c <= 'Z') {
      if (i > 0) out += '-';
      out += c.toLowerCase();
    } else {
      out += c;
    }
  }
  return out;
}

const NODE_KIND_INDEX = new Map<NodeKind, number>(NODE_KINDS.map((k, i) => [k, i]));
const EDGE_KIND_INDEX = new Map<EdgeKind, number>(EDGE_KINDS.map((k, i) => [k, i]));
const NODE_KIND_BY_KEBAB = new Map<string, NodeKind>(NODE_KINDS.map((k) => [kebab(k), k]));
const EDGE_KIND_BY_KEBAB = new Map<string, EdgeKind>(EDGE_KINDS.map((k) => [kebab(k), k]));

export class IdParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdParseError';
  }
}

function splitId(s: string): [string, string] {
  const at = s.indexOf(':');
  if (at < 0) throw new IdParseError(`id "${s}": missing ":"`);
  const kebabPart = s.slice(0, at);
  const ulidPart = s.slice(at + 1);
  if (kebabPart.length === 0 || ulidPart.length !== 26) {
    throw new IdParseError(`id "${s}": wrong shape`);
  }
  canonicalUlid(ulidPart); // throws on a non-canonical spelling
  return [kebabPart, ulidPart];
}

export function formatNodeId(kind: NodeKind, ulid: string): string {
  return `${kebab(kind)}:${ulid}`;
}

export function formatEdgeId(kind: EdgeKind, ulid: string): string {
  return `${kebab(kind)}:${ulid}`;
}

export function parseNodeId(s: string): { kind: NodeKind; ulid: string } {
  const [kebabPart, ulid] = splitId(s);
  const kind = NODE_KIND_BY_KEBAB.get(kebabPart);
  if (!kind) throw new IdParseError(`id "${s}": "${kebabPart}" is not a declared node kind`);
  return { kind, ulid };
}

export function parseEdgeId(s: string): { kind: EdgeKind; ulid: string } {
  const [kebabPart, ulid] = splitId(s);
  const kind = EDGE_KIND_BY_KEBAB.get(kebabPart);
  if (!kind) throw new IdParseError(`id "${s}": "${kebabPart}" is not a declared edge kind`);
  return { kind, ulid };
}

/** Ascending (kind declaration order, then ulid) — the store's own iteration
 * order (`id.rs`'s derived `Ord`), and therefore `Snapshot`'s array order. */
export function compareNodeId(a: string, b: string): number {
  const pa = parseNodeId(a);
  const pb = parseNodeId(b);
  const ki = NODE_KIND_INDEX.get(pa.kind)! - NODE_KIND_INDEX.get(pb.kind)!;
  if (ki !== 0) return ki;
  return pa.ulid < pb.ulid ? -1 : pa.ulid > pb.ulid ? 1 : 0;
}

export function compareEdgeId(a: string, b: string): number {
  const pa = parseEdgeId(a);
  const pb = parseEdgeId(b);
  const ki = EDGE_KIND_INDEX.get(pa.kind)! - EDGE_KIND_INDEX.get(pb.kind)!;
  if (ki !== 0) return ki;
  return pa.ulid < pb.ulid ? -1 : pa.ulid > pb.ulid ? 1 : 0;
}

function insertSorted<T>(arr: readonly T[], item: T, compare: (a: T, b: T) => number): T[] {
  const out = arr.slice();
  let lo = 0;
  let hi = out.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compare(out[mid], item) < 0) lo = mid + 1;
    else hi = mid;
  }
  out.splice(lo, 0, item);
  return out;
}

// ---------------------------------------------------------------------------
// The registry — `FIELD_KEYS` is the one place a wire name is allowed to
// come from (CLAUDE.md rule 3). A name this function does not find is not a
// field that exists, and every call site below is checked by it rather than
// trusted to have typed the string correctly.

export function requireFieldName(name: string): string {
  if (!(name in FIELD_KEYS)) {
    throw new Error(`field "${name}" is not in the schema's field registry`);
  }
  return name;
}

// ---------------------------------------------------------------------------
// The snapshot shape — `crates/fathom-graph/src/snap.rs`.

export type FieldPresence = 'set' | 'absent';

export interface FieldEntry {
  presence: FieldPresence;
  /** A `ProvenanceId` — an entry this document's `provenance` array carries. */
  prov: string;
  /** Present iff `presence === 'set'`. */
  value?: CanonValue;
}

export interface GraphNode {
  id: string;
  existence: string;
  absentSince?: number;
  fields: Readonly<Record<string, FieldEntry>>;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  prov: string;
  absentSince?: number;
  fields: Readonly<Record<string, FieldEntry>>;
}

export type Origin =
  | { kind: 'hand' }
  | { kind: 'parsed'; capture: string; span: { start: number; end: number } };

export type Confidence = 'asserted' | 'derived' | 'heuristic';

export interface ProvenanceRecord {
  id: string;
  origin: Origin;
  assertedAt: number;
  /** `Actor::User` is the one variant this build ships; the ulid of a `UserId`. */
  assertedBy: string;
  confidence: Confidence;
  supersedes?: string;
}

export interface HistoryEntry {
  presence: FieldPresence | 'unknown';
  prov: string;
  value?: CanonValue;
}

export interface HistoryRecord {
  element: string;
  field: string;
  entries: HistoryEntry[];
  truncated: number;
}

export type Op =
  | { type: 'add_node'; node: string; prov: string }
  | { type: 'add_edge'; edge: string; from: string; to: string; prov: string }
  | { type: 'set_field'; element: string; key: string; presence: FieldPresence | 'unknown'; prov: string }
  | { type: 'tombstone'; element: string; at: number; by: string };

export interface Batch {
  id: string;
  label: string;
  ops: Op[];
}

export interface Document {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  provenance: readonly ProvenanceRecord[];
  history: readonly HistoryRecord[];
  batches: readonly Batch[];
}

export function emptyDocument(): Document {
  return { nodes: [], edges: [], provenance: [], history: [], batches: [] };
}

// ---------------------------------------------------------------------------
// Immutable edits. Every command in `commands.ts` is built from these.

export function withNode(doc: Document, node: GraphNode): Document {
  return { ...doc, nodes: insertSorted(doc.nodes, node, (a, b) => compareNodeId(a.id, b.id)) };
}

export function withEdge(doc: Document, edge: GraphEdge): Document {
  return { ...doc, edges: insertSorted(doc.edges, edge, (a, b) => compareEdgeId(a.id, b.id)) };
}

export function withProvenance(doc: Document, record: ProvenanceRecord): Document {
  return {
    ...doc,
    provenance: insertSorted(doc.provenance, record, (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

export function withBatch(doc: Document, batch: Batch): Document {
  return { ...doc, batches: [...doc.batches, batch] };
}

export function replaceNode(doc: Document, id: string, update: (n: GraphNode) => GraphNode): Document {
  return { ...doc, nodes: doc.nodes.map((n) => (n.id === id ? update(n) : n)) };
}

export function replaceEdge(doc: Document, id: string, update: (e: GraphEdge) => GraphEdge): Document {
  return { ...doc, edges: doc.edges.map((e) => (e.id === id ? update(e) : e)) };
}

export function findNode(doc: Document, id: string): GraphNode | undefined {
  return doc.nodes.find((n) => n.id === id);
}

export function findEdge(doc: Document, id: string): GraphEdge | undefined {
  return doc.edges.find((e) => e.id === id);
}

/** Every live (not `absentSince`-marked) edge of `kind` out of `from`. */
export function edgesOut(doc: Document, from: string, kind: EdgeKind): GraphEdge[] {
  return doc.edges.filter(
    (e) => e.from === from && e.absentSince === undefined && parseEdgeId(e.id).kind === kind,
  );
}

export function edgesIn(doc: Document, to: string, kind: EdgeKind): GraphEdge[] {
  return doc.edges.filter(
    (e) => e.to === to && e.absentSince === undefined && parseEdgeId(e.id).kind === kind,
  );
}

// ---------------------------------------------------------------------------
// Provenance: every assertion this module writes is `Origin::Hand`,
// `Confidence::Asserted` (ADR-0036: "Nothing parses a rack" — every fact this
// session's commands write is one a person placed). `LOCAL` mirrors
// `fathom_graph::UserId::LOCAL` (ulid 0): no actor is threaded through the
// four command signatures the brief fixes, and inventing one nobody supplied
// would itself be the kind of fact CLAUDE.md rule 4's neighbours warn against.
// A caller that has a real session actor passes it through `actor` in each
// command's trailing options.
export const LOCAL_ACTOR = '00000000000000000000000000';

export function assertHand(
  doc: Document,
  opts: { assertedAt: number; assertedBy: string; supersedes?: string },
): { doc: Document; id: string } {
  const id = newUlid(opts.assertedAt);
  const record: ProvenanceRecord = {
    id,
    origin: { kind: 'hand' },
    assertedAt: opts.assertedAt,
    assertedBy: opts.assertedBy,
    confidence: 'asserted',
    supersedes: opts.supersedes,
  };
  return { doc: withProvenance(doc, record), id };
}

// ---------------------------------------------------------------------------
// Scalar encoders — `crates/fathom-ir/src/canon.rs`'s rules for the types
// this session's fields use. `Text` accepts any string (its `Scalar::parse`
// never refuses); `Identifier` is non-empty, printable ASCII with no space
// (`0x21..=0x7E`); an integer field is refused outside its declared bit
// width; a generated enum's wire form is its bare token, including an
// undeclared one — every kind-specific enum this schema generates ships an
// `Unknown(String)` arm precisely so a catalogue's own vocabulary (e.g.
// `PortKind::token()`'s `"RJ45"`) can be carried verbatim rather than
// force-fit into the schema's own token set.

export function text(s: string): CanonValue {
  return s;
}

export function identifier(s: string): CanonValue {
  if (s.length === 0) {
    throw new RangeError('Identifier: must not be empty');
  }
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) {
      throw new RangeError(`Identifier: "${s}" contains a byte outside 0x21..=0x7E at index ${i}`);
    }
  }
  return s;
}

export function uint(n: number, bits: 8 | 16 | 32): CanonValue {
  const max = 2 ** bits - 1;
  if (!Number.isInteger(n) || n < 0 || n > max) {
    throw new RangeError(`u${bits}: ${n} is outside 0..=${max}`);
  }
  return n;
}

export function boolField(b: boolean): CanonValue {
  return b;
}

/** A generated enum's wire token — any string; see the doc comment above. */
export function token(s: string): CanonValue {
  return s;
}

function fieldValue(fields: Readonly<Record<string, FieldEntry>>, name: string): CanonValue | undefined {
  const e = fields[name];
  return e && e.presence === 'set' ? e.value : undefined;
}

function asString(v: CanonValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asNumber(v: CanonValue | undefined): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

// ---------------------------------------------------------------------------
// Typed field access for the five kinds this session draws. Reads are always
// total (a field absent, or a document silent about a kind this session did
// not draw, is simply `undefined`); writes go through `requireFieldName` and
// the scalar encoders above.

export interface RackFields {
  label?: string;
  heightU?: number;
  unitNumbering?: string;
}

export function readRackFields(node: GraphNode): RackFields {
  return {
    label: asString(fieldValue(node.fields, 'Rack.label')),
    heightU: asNumber(fieldValue(node.fields, 'Rack.height_u')),
    unitNumbering: asString(fieldValue(node.fields, 'Rack.unit_numbering')),
  };
}

export interface DeviceFields {
  hostname?: string;
}

export function readDeviceFields(node: GraphNode): DeviceFields {
  return { hostname: asString(fieldValue(node.fields, 'Device.hostname')) };
}

export interface ChassisFields {
  model?: string;
  serial?: string;
}

export function readChassisFields(node: GraphNode): ChassisFields {
  return {
    model: asString(fieldValue(node.fields, 'Chassis.model')),
    serial: asString(fieldValue(node.fields, 'Chassis.serial')),
  };
}

export interface PhysicalPortFields {
  label?: string;
  connector?: string;
}

export function readPhysicalPortFields(node: GraphNode): PhysicalPortFields {
  return {
    label: asString(fieldValue(node.fields, 'PhysicalPort.label')),
    connector: asString(fieldValue(node.fields, 'PhysicalPort.connector')),
  };
}

export interface PremisesFields {
  label?: string;
}

export function readPremisesFields(node: GraphNode): PremisesFields {
  return { label: asString(fieldValue(node.fields, 'Premises.label')) };
}

export interface MountedInFields {
  positionU?: number;
  heightU?: number;
  face?: string;
}

export function readMountedInFields(edge: GraphEdge): MountedInFields {
  return {
    positionU: asNumber(fieldValue(edge.fields, 'MountedIn.position_u')),
    heightU: asNumber(fieldValue(edge.fields, 'MountedIn.height_u')),
    face: asString(fieldValue(edge.fields, 'MountedIn.face')),
  };
}

export { NODE_KINDS, EDGE_KINDS };
export type { NodeKind, EdgeKind };
