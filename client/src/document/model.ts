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

/** Refused: an id this document has no live node/edge for. Lives here
 * (rather than in `commands.ts`, where it was born) so `edit.ts` can throw
 * it without importing `commands.ts` — `commands.ts` itself now imports
 * `edit.ts`'s `FieldValueError` (ADR-0051 §1's `createSurface`/
 * `addSketchPort`), and a two-way import between those two modules would be
 * a real cycle, not just an inconvenience. `commands.ts` re-exports this
 * class so every existing `import { UnknownReferenceError } from './commands'`
 * (`cables.ts`, `supplies.ts`, the test files) keeps working unchanged. */
export class UnknownReferenceError extends Error {
  readonly id: string;
  readonly wanted: string;
  constructor(id: string, wanted: string) {
    super(`${wanted} "${id}" is not in this document`);
    this.name = 'UnknownReferenceError';
    this.id = id;
    this.wanted = wanted;
  }
}

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
  | { type: 'tombstone'; element: string; at: number; by: string }
  /** ADR-0053 §1 — the fifth op: reviving a tombstoned element, because a
   * re-add under a new id would lose identity, history and capture links.
   * `crates/fathom-workspace/src/lib.rs`'s `Op::Revive` carries the same
   * three fields as `Tombstone`, for the same reason (an authored act, not
   * entitled to travel with no name attached). */
  | { type: 'revive'; element: string; at: number; by: string };

export interface Batch {
  id: string;
  label: string;
  ops: Op[];
  /** ADR-0053 §4 — a comment on a pending change. Optional on the wire,
   * omitted when absent. */
  comment?: string;
  /** ADR-0053 §4/§1 — the batch this one reverses, when this batch is an
   * undo (or a redo — the undo of an undo). Optional, omitted when this
   * batch is not itself a reversal. */
  reverses?: string;
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

// ---------------------------------------------------------------------------
// History — the browser side of `fathom-graph::Graph::archive_replaced`
// (`crates/fathom-graph/src/graph.rs`): every field write moves the slot it
// replaces into the side table first, so an undo asking for the prior value
// finds one. `11` §8.6's retention rule is mirrored too — "the most recent 16
// entries, plus the earliest entry from each distinct Origin discriminant,
// always" — computed from `doc.provenance` rather than a parallel origins
// array, since `HistoryEntry`'s own wire shape (`plain.ts`) carries no origin
// column and one is not invented here either; an entry's origin is always
// resolvable from its `prov` because provenance records are append-only
// (`withProvenance` never removes one).
const HISTORY_RECENT = 16;

function originOf(doc: Document, provId: string): Origin['kind'] {
  return doc.provenance.find((p) => p.id === provId)?.origin.kind ?? 'hand';
}

function pruneHistoryEntries(doc: Document, entries: HistoryEntry[]): { entries: HistoryEntry[]; dropped: number } {
  const n = entries.length;
  if (n <= HISTORY_RECENT) return { entries, dropped: 0 };
  const keep = new Array<boolean>(n).fill(false);
  for (let i = n - HISTORY_RECENT; i < n; i += 1) keep[i] = true;
  const seenOrigins = new Set<Origin['kind']>();
  for (let i = 0; i < n; i += 1) {
    const origin = originOf(doc, entries[i].prov);
    if (!seenOrigins.has(origin)) {
      seenOrigins.add(origin);
      keep[i] = true;
    }
  }
  const kept = entries.filter((_, i) => keep[i]);
  return { entries: kept, dropped: n - kept.length };
}

/** Archive `replaced` (the entry a field write is about to overwrite) into
 * `doc.history` for `(element, field)` — `archive_replaced`'s own "move the
 * replaced slot into history" (`graph.rs`), called by every `setField`-style
 * writer (`commands.ts`, `edit.ts`, `undo.ts`) BEFORE the new entry is
 * written, so a value is never simply gone the moment it is edited. Entries
 * are oldest first, matching `FieldHistory::entries`'s own doc comment. */
export function archiveField(doc: Document, element: string, field: string, replaced: FieldEntry): Document {
  const idx = doc.history.findIndex((h) => h.element === element && h.field === field);
  const prior = idx >= 0 ? doc.history[idx] : undefined;
  const appended: HistoryEntry[] = [
    ...(prior?.entries ?? []),
    { presence: replaced.presence, prov: replaced.prov, value: replaced.value },
  ];
  const { entries, dropped } = pruneHistoryEntries(doc, appended);
  const record: HistoryRecord = { element, field, entries, truncated: (prior?.truncated ?? 0) + dropped };
  const history = idx >= 0 ? doc.history.map((h, i) => (i === idx ? record : h)) : [...doc.history, record];
  return { ...doc, history };
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
  /** ADR-0050 §2 — the row the rack stands in, and its bay within it. Both
   * `0..1`: a rack recorded before its closet stop existed has said
   * something true, and neither is invented for it. */
  row?: string;
  bay?: number;
}

export function readRackFields(node: GraphNode): RackFields {
  return {
    label: asString(fieldValue(node.fields, 'Rack.label')),
    heightU: asNumber(fieldValue(node.fields, 'Rack.height_u')),
    unitNumbering: asString(fieldValue(node.fields, 'Rack.unit_numbering')),
    row: asString(fieldValue(node.fields, 'Rack.row')),
    bay: asNumber(fieldValue(node.fields, 'Rack.bay')),
  };
}

/** ADR-0050 §4 — a field-replaceable power supply seated in a Chassis slot
 * (`FittedIn`). `slot` is the vendor's own word for the bay ("PSU 0",
 * "PEM A"), the same string the catalogue's `CataloguePsuSlot.name` gives. */
export interface PowerSupplyFields {
  slot?: string;
  serial?: string;
  model?: string;
}

export function readPowerSupplyFields(node: GraphNode): PowerSupplyFields {
  return {
    slot: asString(fieldValue(node.fields, 'PowerSupply.slot')),
    serial: asString(fieldValue(node.fields, 'PowerSupply.serial')),
    model: asString(fieldValue(node.fields, 'PowerSupply.model')),
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
  /** ADR-0051 §1 — the faceplate this port sits on. Absent means: fall back
   * to the catalogue's own faceplate, or `'front'` — `view.ts`'s own rule. */
  face?: string;
  service?: string;
}

export function readPhysicalPortFields(node: GraphNode): PhysicalPortFields {
  return {
    label: asString(fieldValue(node.fields, 'PhysicalPort.label')),
    connector: asString(fieldValue(node.fields, 'PhysicalPort.connector')),
    face: asString(fieldValue(node.fields, 'PhysicalPort.face')),
    service: asString(fieldValue(node.fields, 'PhysicalPort.service')),
  };
}

/** ADR-0051 §1 — a splitter, ODF, patch panel, shelf, outlet, board or other
 * passive (`PassiveNode.form`'s own enum). */
export interface PassiveNodeFields {
  label?: string;
  form?: string;
  model?: string;
  serial?: string;
}

export function readPassiveNodeFields(node: GraphNode): PassiveNodeFields {
  return {
    label: asString(fieldValue(node.fields, 'PassiveNode.label')),
    form: asString(fieldValue(node.fields, 'PassiveNode.form')),
    model: asString(fieldValue(node.fields, 'PassiveNode.model')),
    serial: asString(fieldValue(node.fields, 'PassiveNode.serial')),
  };
}

/** ADR-0051 §1 — a wall, floor, desk or ceiling. */
export interface SurfaceFields {
  label?: string;
  form?: string;
  widthMm?: number;
  heightMm?: number;
}

export function readSurfaceFields(node: GraphNode): SurfaceFields {
  return {
    label: asString(fieldValue(node.fields, 'Surface.label')),
    form: asString(fieldValue(node.fields, 'Surface.form')),
    widthMm: asNumber(fieldValue(node.fields, 'Surface.width_mm')),
    heightMm: asNumber(fieldValue(node.fields, 'Surface.height_mm')),
  };
}

/** ADR-0051 §1 — `SitsOn.slot`: the place on a shelf, left to right, 1 first. */
export interface SitsOnFields {
  slot?: number;
}

export function readSitsOnFields(edge: GraphEdge): SitsOnFields {
  return { slot: asNumber(fieldValue(edge.fields, 'SitsOn.slot')) };
}

/** ADR-0051 §1 — `FixedTo.x_mm`/`.y_mm`, both `0..1` (absent means fixed with
 * the position not yet measured — `schema/schema.yaml`'s own doc on why). */
export interface FixedToFields {
  xMm?: number;
  yMm?: number;
}

export function readFixedToFields(edge: GraphEdge): FixedToFields {
  return {
    xMm: asNumber(fieldValue(edge.fields, 'FixedTo.x_mm')),
    yMm: asNumber(fieldValue(edge.fields, 'FixedTo.y_mm')),
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
