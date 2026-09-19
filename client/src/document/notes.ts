// ADR-0053 §5/§6 — a note is a node, not a field: `Note`, owned through the
// `Notable` class (Device, PhysicalPort, Rack) by the containment edge
// `HasNote`. Device, not Chassis — the device has the page, the hostname
// and the capture; Rack's own "no notes field" stays true because a note
// reached through `HasNote` is a node, never a field Rack itself declares.
//
// Pasted text goes through the redaction gate FIRST, by `engine.ts`'s
// `redactText` (`OP_REDACT_TEXT`, ADR-0053 §6) — this module never calls the
// gate itself and never writes anything but the text it is handed, the same
// division `plain.ts`'s own header draws between a format and the referee
// that polices what enters it: `addNote` trusts its caller to have already
// run a pasted note's text through the door, exactly as `plain.ts`'s writer
// trusts the graph's own shape was checked upstream.

import {
  LOCAL_ACTOR,
  UnknownReferenceError,
  assertHand,
  edgesIn,
  edgesOut,
  findNode,
  formatEdgeId,
  formatNodeId,
  parseNodeId,
  requireFieldName,
  text,
  token,
  uint,
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

interface Actor {
  actor?: string;
  now?: number;
}

function resolve(opts: Actor | undefined): { actor: string; now: number } {
  return { actor: opts?.actor ?? LOCAL_ACTOR, now: opts?.now ?? Date.now() };
}

/** `Notable` (`schema/schema.yaml`) — the only three kinds a `HasNote` may
 * own. Chassis is deliberately not one of them (schema's own doc on why). */
const NOTABLE_KINDS: readonly NodeKind[] = ['Device', 'PhysicalPort', 'Rack'];

/** Refused: `ownerId` is a live node of some kind, but not one `Notable`
 * lists. Never thrown for an unknown id at all — that stays
 * `UnknownReferenceError`, `model.ts`'s own class. */
export class NotNotableError extends Error {
  readonly ownerId: string;
  constructor(ownerId: string) {
    super(`"${ownerId}" is not a Device, PhysicalPort or Rack — it cannot own a note`);
    this.name = 'NotNotableError';
    this.ownerId = ownerId;
  }
}

export type NoteHow = 'typed' | 'pasted';

export interface AddNoteOptions extends Actor {
  text: string;
  how: NoteHow;
  /** `Note.line_count` — schema card `card: "0..1"`: present only when
   * `how` is `'pasted'`; a typed note has no gutter to count. Ignored (never
   * written) when `how` is `'typed'`, rather than refused — the schema's own
   * doc says what an absent count means, not what a stray one would. */
  lineCount?: number;
}

/**
 * ADR-0053 §5 — a `Note`, `HasNote`'d off `ownerId`. Refuses an owner this
 * document has no live node for (`UnknownReferenceError`) or one outside
 * `Notable` (`NotNotableError`).
 */
export function addNote(doc: Document, ownerId: string, opts: AddNoteOptions): Document {
  const owner = findNode(doc, ownerId);
  if (!owner || owner.absentSince !== undefined) {
    throw new UnknownReferenceError(ownerId, 'a Device, PhysicalPort or Rack');
  }
  if (!NOTABLE_KINDS.includes(parseNodeId(ownerId).kind)) {
    throw new NotNotableError(ownerId);
  }

  const { actor, now } = resolve(opts);
  let working = doc;
  const ops: Op[] = [];

  const existence = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = existence.doc;
  const noteId = formatNodeId('Note', newUlid(now));

  const fields: Record<string, FieldEntry> = {};
  const fieldOps: Op[] = [];

  requireFieldName('Note.text');
  const textProv = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = textProv.doc;
  fields['Note.text'] = { presence: 'set', prov: textProv.id, value: text(opts.text) };
  fieldOps.push({ type: 'set_field', element: noteId, key: 'Note.text', presence: 'set', prov: textProv.id });

  requireFieldName('Note.how');
  const howProv = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = howProv.doc;
  fields['Note.how'] = { presence: 'set', prov: howProv.id, value: token(opts.how) };
  fieldOps.push({ type: 'set_field', element: noteId, key: 'Note.how', presence: 'set', prov: howProv.id });

  if (opts.how === 'pasted' && opts.lineCount !== undefined) {
    requireFieldName('Note.line_count');
    const lineCountProv = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = lineCountProv.doc;
    fields['Note.line_count'] = { presence: 'set', prov: lineCountProv.id, value: uint(opts.lineCount, 32) };
    fieldOps.push({
      type: 'set_field',
      element: noteId,
      key: 'Note.line_count',
      presence: 'set',
      prov: lineCountProv.id,
    });
  }

  working = withNode(working, { id: noteId, existence: existence.id, fields });
  ops.push({ type: 'add_node', node: noteId, prov: existence.id }, ...fieldOps);

  const edgeProv = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = edgeProv.doc;
  const edgeId = formatEdgeId('HasNote', newUlid(now));
  working = withEdge(working, { id: edgeId, from: ownerId, to: noteId, prov: edgeProv.id, fields: {} });
  ops.push({ type: 'add_edge', edge: edgeId, from: ownerId, to: noteId, prov: edgeProv.id });

  const batch: Batch = { id: newUlid(now), label: 'add note', ops };
  return withBatch(working, batch);
}

/**
 * The reverse of `addNote`: tombstones the note and the `HasNote` edge that
 * owns it, together — `removeChassis`'s own precedent (`commands.ts`) for
 * retiring a node with the edge that contained it in the same batch.
 * Refuses a `noteId` with no live owning edge (`UnknownReferenceError`).
 */
export function removeNote(doc: Document, noteId: string, opts?: Actor): Document {
  const hasNote = edgesIn(doc, noteId, 'HasNote')[0];
  if (!hasNote) throw new UnknownReferenceError(noteId, 'a Note owned by something in this document');

  const { actor, now } = resolve(opts);
  const working: Document = {
    ...doc,
    nodes: doc.nodes.map((n) => (n.id === noteId ? { ...n, absentSince: now } : n)),
    edges: doc.edges.map((e) => (e.id === hasNote.id ? { ...e, absentSince: now } : e)),
  };
  const ops: Op[] = [
    { type: 'tombstone', element: noteId, at: now, by: actor },
    { type: 'tombstone', element: hasNote.id, at: now, by: actor },
  ];
  const batch: Batch = { id: newUlid(now), label: 'remove note', ops };
  return withBatch(working, batch);
}

export interface NoteView {
  id: string;
  text: string;
  how: NoteHow;
  lineCount?: number;
  /** Who and when — the note's own existence provenance
   * (`ProvenanceRecord.assertedBy`/`.assertedAt`); `Note` itself declares
   * neither field (schema's own doc on why). */
  who: string;
  when: number;
}

function fieldValue(fields: Readonly<Record<string, FieldEntry>>, key: string): FieldEntry['value'] | undefined {
  const e = fields[key];
  return e && e.presence === 'set' ? e.value : undefined;
}

function readNoteView(doc: Document, noteId: string): NoteView | undefined {
  const node = findNode(doc, noteId);
  if (!node || node.absentSince !== undefined) return undefined;
  const provRecord = doc.provenance.find((p) => p.id === node.existence);
  const textValue = fieldValue(node.fields, 'Note.text');
  const howValue = fieldValue(node.fields, 'Note.how');
  const lineCountValue = fieldValue(node.fields, 'Note.line_count');
  return {
    id: noteId,
    text: typeof textValue === 'string' ? textValue : '',
    how: howValue === 'pasted' ? 'pasted' : 'typed',
    lineCount: typeof lineCountValue === 'number' ? lineCountValue : undefined,
    who: provRecord?.assertedBy ?? LOCAL_ACTOR,
    when: provRecord?.assertedAt ?? 0,
  };
}

/** Every live note on `ownerId`, in `HasNote` order. */
export function notesOf(doc: Document, ownerId: string): NoteView[] {
  const out: NoteView[] = [];
  for (const edge of edgesOut(doc, ownerId, 'HasNote')) {
    const view = readNoteView(doc, edge.to);
    if (view) out.push(view);
  }
  return out;
}
