// ADR-0053 §1/§3 — undo as a new batch of reversing operations, recorded and
// saved like any other change; redo is the undo of that. `model.ts`'s
// `archiveField` (mirroring `fathom-graph`'s own `archive_replaced`) is what
// makes a field's reversal possible at all: without it, the prior value was
// gone the moment it was edited.

import type { CanonValue } from './canon';
import {
  LOCAL_ACTOR,
  UnknownReferenceError,
  archiveField,
  assertHand,
  edgesIn,
  findEdge,
  findNode,
  parseEdgeId,
  readMountedInFields,
  replaceEdge,
  replaceNode,
  withBatch,
  type Batch,
  type Document,
  type FieldEntry,
  type FieldPresence,
  type GraphEdge,
  type Op,
} from './model';
import { decodeUlid, newUlid } from './ulid';

// ---------------------------------------------------------------------------
// Whose batch is this?

/** The op's own actor: a provenance-carrying op names it through
 * `doc.provenance`; `tombstone`/`revive` carry `by` directly (a removal or a
 * revival is exactly as authored an act as a field set, `op.rs`'s own
 * reason for `Tombstone`/`Revive` both carrying `by`). `undefined` only for
 * a dangling `prov` this client's own writers never produce. */
function actorOfOp(doc: Document, op: Op): string | undefined {
  switch (op.type) {
    case 'add_node':
    case 'add_edge':
    case 'set_field':
      return doc.provenance.find((p) => p.id === op.prov)?.assertedBy;
    case 'tombstone':
    case 'revive':
      return op.by;
  }
}

/** The one actor every op in `batch` shares — batches are single-actor by
 * construction (every command in `commands.ts`/`edit.ts` stamps one actor on
 * the whole batch it builds). `undefined` for an empty batch, or one whose
 * ops disagree (a mixed batch — never produced by this client's own
 * writers, but not assumed away here either). */
export function batchActor(doc: Document, batch: Batch): string | undefined {
  let actor: string | undefined;
  for (const op of batch.ops) {
    const a = actorOfOp(doc, op);
    if (a === undefined) return undefined;
    if (actor === undefined) actor = a;
    else if (actor !== a) return undefined;
  }
  return actor;
}

/** `accountId`'s own batches, newest first, that no other batch has already
 * reversed. An undo batch is itself an ordinary batch and so is itself
 * undoable (redoable) exactly once more, until something reverses IT in
 * turn. A batch stamped `LOCAL_ACTOR` — or one with no single actor — is
 * never listed, for any `accountId`, `LOCAL_ACTOR` included: nobody is
 * signed in as the sentinel (a batch it stamped is not undoable). */
export function undoable(doc: Document, accountId: string): Batch[] {
  const reversed = new Set(doc.batches.map((b) => b.reverses).filter((r): r is string => r !== undefined));
  const out: Batch[] = [];
  for (let i = doc.batches.length - 1; i >= 0; i -= 1) {
    const batch = doc.batches[i];
    if (reversed.has(batch.id)) continue;
    const actor = batchActor(doc, batch);
    if (actor === undefined || actor === LOCAL_ACTOR) continue;
    if (actor !== accountId) continue;
    out.push(batch);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conflict

export type UndoConflict =
  /** The batch has no single, real actor to attribute it to — a
   * `LOCAL_ACTOR`-stamped batch (pre-account data) or a mixed one — so there
   * is nobody's undo this could be. */
  | { kind: 'unattributed' }
  /** A later batch by a DIFFERENT actor touched an element this batch also
   * touched — undo refuses rather than silently overwriting a colleague's
   * change. */
  | { kind: 'later-change'; batchId: string; label: string; actor: string; at: number }
  /** ADR-0053 §3 — "You undo your own changes": the batch is somebody else's,
   * checked against the account asking to undo (or redo) it. */
  | { kind: 'not-yours'; actor: string }
  /** ADR-0053 §1 — reviving this batch's tombstoned element would land it
   * where something else now stands (the same check `check_edge_l0` runs for
   * an ordinary add, re-run here for the edge kinds this client revives). */
  | { kind: 'revive-refused'; element: string; reason: string };

/** Every element `batch` touched: each op's own element, plus — when that
 * element is (or was) an edge — its two endpoints, so a colleague's edit to
 * either end of an edge this batch added or removed still counts as
 * touching what the batch touched. */
function touchedElements(doc: Document, batch: Batch): Set<string> {
  const out = new Set<string>();
  const addEdgeAndEndpoints = (edgeId: string, from?: string, to?: string): void => {
    out.add(edgeId);
    if (from !== undefined && to !== undefined) {
      out.add(from);
      out.add(to);
      return;
    }
    const edge = findEdge(doc, edgeId);
    if (edge) {
      out.add(edge.from);
      out.add(edge.to);
    }
  };
  for (const op of batch.ops) {
    switch (op.type) {
      case 'add_node':
        out.add(op.node);
        break;
      case 'add_edge':
        addEdgeAndEndpoints(op.edge, op.from, op.to);
        break;
      case 'set_field':
        addEdgeAndEndpoints(op.element);
        break;
      case 'tombstone':
      case 'revive':
        addEdgeAndEndpoints(op.element);
        break;
    }
  }
  return out;
}

/** The wall-clock millisecond a ulid was minted at — its top 48 bits
 * (`ulid.ts`'s own layout doc), used here to give a conflicting batch a time
 * without `Batch` carrying one of its own. */
function ulidTimestampMs(id: string): number {
  return Number(decodeUlid(id) >> 80n);
}

/** Would undoing (or redoing) `batchId` conflict? `undefined` when it would
 * not. `requestingActor`, when given, is the account asking to undo (or
 * redo) the batch — ADR-0053 §3's "you undo your own changes", checked here
 * rather than only in `undoable`'s list-building so a direct call (not just
 * the chip's own candidate list) is refused too. Omitted, the check is
 * skipped — a caller that has not settled who is asking (or is checking a
 * batch's OWN standing, not a specific request to reverse it) gets the
 * older, ownership-blind answer. */
export function conflict(doc: Document, batchId: string, requestingActor?: string): UndoConflict | undefined {
  const batch = doc.batches.find((b) => b.id === batchId);
  if (!batch) throw new UnknownReferenceError(batchId, 'a batch');

  const actor = batchActor(doc, batch);
  if (actor === undefined || actor === LOCAL_ACTOR) {
    return { kind: 'unattributed' };
  }

  if (requestingActor !== undefined && requestingActor !== actor) {
    return { kind: 'not-yours', actor };
  }

  const touched = touchedElements(doc, batch);
  const index = doc.batches.indexOf(batch);
  for (const later of doc.batches.slice(index + 1)) {
    const laterActor = batchActor(doc, later);
    if (laterActor === undefined || laterActor === actor) continue;
    const laterTouched = touchedElements(doc, later);
    let hit = false;
    for (const el of laterTouched) {
      if (touched.has(el)) {
        hit = true;
        break;
      }
    }
    if (hit) {
      return {
        kind: 'later-change',
        batchId: later.id,
        label: later.label,
        actor: laterActor,
        at: ulidTimestampMs(later.id),
      };
    }
  }
  return undefined;
}

function conflictMessage(c: UndoConflict): string {
  switch (c.kind) {
    case 'unattributed':
      return 'this change has no single account to attribute it to and cannot be undone';
    case 'later-change':
      return `"${c.label}" (by ${c.actor}) touched the same element afterwards — undo refuses rather than overwrite it`;
    case 'not-yours':
      return `this change is ${c.actor}'s, not yours to undo`;
    case 'revive-refused':
      return `undo refused: ${c.reason}`;
  }
}

export class UndoConflictError extends Error {
  readonly conflict: UndoConflict;
  constructor(conflict: UndoConflict) {
    super(conflictMessage(conflict));
    this.name = 'UndoConflictError';
    this.conflict = conflict;
  }
}

// ---------------------------------------------------------------------------
// Reversal

/** `crates/fathom-graph/src/op.rs`'s `LABEL_MAX_BYTES`, mirrored rather than
 * imported (it is `pub(crate)`, not part of the schema or the wire): the
 * bound a batch label is refused past, so "undo of <label>"/"redo of
 * <label>" never mints a label the engine would refuse. */
const LABEL_MAX_BYTES = 60;

/** Cut `s` at `maxBytes` UTF-8 bytes, on a character boundary — never
 * mid-codepoint. */
function truncateUtf8(s: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(s).length <= maxBytes) return s;
  let end = s.length;
  while (end > 0 && encoder.encode(s.slice(0, end)).length > maxBytes) {
    end -= 1;
  }
  return s.slice(0, end);
}

function markAbsent(doc: Document, elementId: string, at: number): Document {
  if (findNode(doc, elementId)) {
    return { ...doc, nodes: doc.nodes.map((n) => (n.id === elementId ? { ...n, absentSince: at } : n)) };
  }
  return { ...doc, edges: doc.edges.map((e) => (e.id === elementId ? { ...e, absentSince: at } : e)) };
}

function markLive(doc: Document, elementId: string): Document {
  if (findNode(doc, elementId)) {
    return { ...doc, nodes: doc.nodes.map((n) => (n.id === elementId ? { ...n, absentSince: undefined } : n)) };
  }
  return { ...doc, edges: doc.edges.map((e) => (e.id === elementId ? { ...e, absentSince: undefined } : e)) };
}

/** `set_field` -> `set_field`, restoring the prior presence and value from
 * `doc.history`: `op`'s own provenance record names what it superseded, and
 * that entry — archived by the very write this is undoing — is what comes
 * back. The reversal is itself an ordinary field write: a fresh provenance
 * record, `supersedes` chained onto whatever is CURRENTLY live, and the
 * entry it replaces archived in turn (`archiveField`), so a redo of this
 * undo has its own prior value to find later. No prior entry (the field's
 * very first assertion) reverses to `'unknown'` — the slot removed
 * entirely, matching `fathom-graph::clear_field`'s own result when nothing
 * was there to restore. */
function reverseSetField(
  doc: Document,
  actor: string,
  now: number,
  op: Extract<Op, { type: 'set_field' }>,
): { doc: Document; op: Op } {
  const supersedes = doc.provenance.find((p) => p.id === op.prov)?.supersedes;
  let restoredPresence: FieldPresence | 'unknown' = 'unknown';
  let restoredValue: CanonValue | undefined;
  if (supersedes !== undefined) {
    const record = doc.history.find((h) => h.element === op.element && h.field === op.key);
    const entry = record?.entries.find((e) => e.prov === supersedes);
    if (entry) {
      restoredPresence = entry.presence;
      restoredValue = entry.value;
    }
  }

  const node = findNode(doc, op.element);
  const edge = node ? undefined : findEdge(doc, op.element);
  const fields = node?.fields ?? edge?.fields;
  if (!fields) throw new UnknownReferenceError(op.element, 'a node or edge');
  const existing = fields[op.key];

  const prov = assertHand(doc, { assertedAt: now, assertedBy: actor, supersedes: existing?.prov });
  let working = existing !== undefined ? archiveField(prov.doc, op.element, op.key, existing) : prov.doc;

  let newFields: Record<string, FieldEntry>;
  if (restoredPresence === 'unknown') {
    const rest: Record<string, FieldEntry> = { ...fields };
    delete rest[op.key];
    newFields = rest;
  } else {
    const entry: FieldEntry =
      restoredPresence === 'set'
        ? { presence: 'set', prov: prov.id, value: restoredValue }
        : { presence: 'absent', prov: prov.id };
    newFields = { ...fields, [op.key]: entry };
  }

  working = node
    ? replaceNode(working, op.element, (n) => ({ ...n, fields: newFields }))
    : replaceEdge(working, op.element, (e) => ({ ...e, fields: newFields }));

  return {
    doc: working,
    op: { type: 'set_field', element: op.element, key: op.key, presence: restoredPresence, prov: prov.id },
  };
}

function reverseOp(doc: Document, actor: string, now: number, op: Op): { doc: Document; op: Op } {
  switch (op.type) {
    case 'add_node':
      return { doc: markAbsent(doc, op.node, now), op: { type: 'tombstone', element: op.node, at: now, by: actor } };
    case 'add_edge':
      return { doc: markAbsent(doc, op.edge, now), op: { type: 'tombstone', element: op.edge, at: now, by: actor } };
    case 'set_field':
      return reverseSetField(doc, actor, now, op);
    case 'tombstone':
      // ADR-0053 §1 — revive re-runs the same containment check an add does.
      // The client, not a live `fathom-graph::Graph`, is what writes the
      // saved document on this path, so that check has to be run here too —
      // `refuseIfReviveConflicts`, called once `reverseBatch` has the whole
      // batch's final state to check against.
      return { doc: markLive(doc, op.element), op: { type: 'revive', element: op.element, at: now, by: actor } };
    case 'revive':
      return { doc: markAbsent(doc, op.element, now), op: { type: 'tombstone', element: op.element, at: now, by: actor } };
  }
}

/** `MountedIn`'s own `position_u`/`height_u` run, live edges into `rackId`
 * only (`edgesIn` already excludes a tombstoned edge). Mirrors
 * `commands.ts`'s own `occupiedRanges`, which is private to that module —
 * duplicated rather than exported for one caller, the same tradeoff this
 * file's header already makes for `archiveField`'s siblings. */
function overlappingMountedIn(doc: Document, rackId: string, edgeId: string, positionU: number, heightU: number): GraphEdge | undefined {
  const top = positionU + heightU - 1;
  return edgesIn(doc, rackId, 'MountedIn').find((other) => {
    if (other.id === edgeId) return false;
    const otherFields = readMountedInFields(other);
    if (otherFields.positionU === undefined) return false;
    const otherTop = otherFields.positionU + (otherFields.heightU ?? 1) - 1;
    return positionU <= otherTop && otherFields.positionU <= top;
  });
}

/** ADR-0053 §1 — the containment/cardinality check a revived edge must pass
 * "so a revived edge passes only if nothing replaced it", checked against
 * `doc` AFTER the whole batch's reversal has been built (so an edge and the
 * node it depends on, tombstoned and revived together by the same batch —
 * `removeChassis`'s own shape — see each other as live, not as they stood
 * mid-reversal).
 *
 * Two checks, not the general one `fathom-graph::check_edge_l0` runs,
 * because the client has no generated cardinality/class table for edge kinds
 * to check against generically (`schema/generated/ir_types.ts` carries the
 * kind lists, not the bounds) — narrowed to what this client's own writers
 * can revive:
 *   1. Both endpoints must currently stand. An edge cannot be live over a
 *      dead node — `notes.ts`'s own `addNote` already refuses to draw
 *      `HasNote` from a tombstoned owner; a revive is the one write that can
 *      otherwise land one anyway.
 *   2. `MountedIn` re-runs `placeChassis`'s own no-overlap rule: a revived
 *      slot is refused if the rack unit run it names has since been retaken.
 */
function refuseIfReviveConflicts(doc: Document, edgeId: string): UndoConflict | undefined {
  const edge = findEdge(doc, edgeId);
  if (!edge) return undefined; // a revived NODE, not an edge — nothing to check here
  const from = findNode(doc, edge.from);
  const to = findNode(doc, edge.to);
  if (!from || from.absentSince !== undefined || !to || to.absentSince !== undefined) {
    return { kind: 'revive-refused', element: edgeId, reason: `"${edgeId}" would stand over an element that is gone` };
  }

  if (parseEdgeId(edgeId).kind === 'MountedIn') {
    const fields = readMountedInFields(edge);
    if (fields.positionU !== undefined) {
      const collision = overlappingMountedIn(doc, edge.to, edgeId, fields.positionU, fields.heightU ?? 1);
      if (collision) {
        return {
          kind: 'revive-refused',
          element: edgeId,
          reason: `U${fields.positionU} in rack "${edge.to}" is occupied by "${collision.from}"`,
        };
      }
    }
  }
  return undefined;
}

function reverseBatch(
  doc: Document,
  batchId: string,
  opts: { actor: string; now: number },
  prefix: 'undo' | 'redo',
): Document {
  const target = doc.batches.find((b) => b.id === batchId);
  if (!target) throw new UnknownReferenceError(batchId, 'a batch');

  const { actor, now } = opts;

  const c = conflict(doc, batchId, actor);
  if (c) throw new UndoConflictError(c);

  let working = doc;
  const ops: Op[] = [];
  const revivedEdgeIds: string[] = [];
  for (const op of [...target.ops].reverse()) {
    const r = reverseOp(working, actor, now, op);
    working = r.doc;
    ops.push(r.op);
    if (r.op.type === 'revive') revivedEdgeIds.push(r.op.element);
  }

  // ADR-0053 §1 — checked once, against the batch's FULL final state: an
  // element this same batch both revives (a node) and re-attaches (an edge
  // onto it) must see the node as already live, not as it stood mid-reversal.
  for (const edgeId of revivedEdgeIds) {
    const revived = refuseIfReviveConflicts(working, edgeId);
    if (revived) throw new UndoConflictError(revived);
  }

  const label = truncateUtf8(`${prefix} of ${target.label}`, LABEL_MAX_BYTES);
  const batch: Batch = { id: newUlid(now), label, ops, reverses: target.id };
  return withBatch(working, batch);
}

/** A new batch of reversing ops, in reverse order — add becomes tombstone,
 * set_field becomes set_field to the prior presence and value, tombstone
 * becomes revive — labelled "undo of <label>", `reverses` set to the batch
 * it reverses. Refuses (`UndoConflictError`): per `conflict`'s rules (`opts.actor`
 * checked against the batch's own — ADR-0053 §3), or per
 * `refuseIfReviveConflicts` for a revived edge that would land somewhere
 * something else now stands. */
export function undo(doc: Document, batchId: string, opts: { actor: string; now: number }): Document {
  return reverseBatch(doc, batchId, opts, 'undo');
}

/** Redo: the undo of the undo — same mechanism, labelled "redo of <label>". */
export function redo(doc: Document, undoBatchId: string, opts: { actor: string; now: number }): Document {
  return reverseBatch(doc, undoBatchId, opts, 'redo');
}
