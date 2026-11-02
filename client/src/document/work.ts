// The Work tab's ticket parts on one piece of work (sign-off r74, schema 0.34): who it is assigned
// to, when an issue is due, and the same work in an outside tool. A plan, an issue and a spare that
// is out each carry them; comments are Notes on the item (`notes.ts`), who and when from their
// provenance. The Fathom number is not here: the server gives it (`api/work.ts`).
//
// Typed text is stored as typed; pasted text goes through `gate` first, as plan text does
// (`plans.ts`). All pure.

import { UnknownReferenceError } from './commands';
import {
  LOCAL_ACTOR,
  archiveField,
  assertHand,
  asString,
  fieldValue,
  findNode,
  parseNodeId,
  replaceNode,
  requireFieldName,
  text,
  withBatch,
  type Document,
  type FieldEntry,
  type Op,
} from './model';
import type { TextGate } from './plans';
import { newUlid } from './ulid';

export type WorkKind = 'MaintenancePlan' | 'Issue' | 'StockItem';
export type WorkField = 'assigned_to' | 'due' | 'ticket';

/** Which of the three each kind carries: a plan has its window and a spare its own due. */
const FIELDS: Record<WorkKind, readonly WorkField[]> = {
  MaintenancePlan: ['assigned_to', 'ticket'],
  Issue: ['assigned_to', 'due', 'ticket'],
  StockItem: ['assigned_to', 'ticket'],
};

/** The kind of `id` when it is a piece of work, else null. */
export function workKindOf(id: string): WorkKind | null {
  try {
    const kind = parseNodeId(id).kind;
    return kind === 'MaintenancePlan' || kind === 'Issue' || kind === 'StockItem' ? kind : null;
  } catch {
    return null;
  }
}

export function workFieldsOf(kind: WorkKind): readonly WorkField[] {
  return FIELDS[kind];
}

export interface WorkParts {
  assignedTo: string;
  /** An issue's due date; a spare's own `due`; empty for a plan. */
  due: string;
  ticket: string;
}

export function readWork(doc: Document, id: string): WorkParts | null {
  const kind = workKindOf(id);
  const node = findNode(doc, id);
  if (kind == null || !node || node.absentSince !== undefined) return null;
  const read = (f: string) => asString(fieldValue(node.fields, `${kind}.${f}`)) ?? '';
  return { assignedTo: read('assigned_to'), due: kind === 'MaintenancePlan' ? '' : read('due'), ticket: read('ticket') };
}

/** An ISO date (`2026-11-07`): what the date picker gives and the Work tab sorts by. */
export function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

export class WorkFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkFieldError';
  }
}

/** A link worth opening: http or https only, so a stored `javascript:` is never a link. */
export function ticketHref(ticket: string): string | null {
  const t = ticket.trim();
  if (!/^https?:\/\//i.test(t)) return null;
  try {
    const url = new URL(t);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Set one ticket part on a plan, issue or spare, as one undo step; empty clears it. `assigned_to`
 * is an account id from the list of people who may work there, never typed. `due` must be an ISO
 * date. `ticket` is text, gated when pasted.
 */
export function setWorkField(
  doc: Document,
  id: string,
  field: WorkField,
  value: string,
  opts: { gate: TextGate; actor?: string; now?: number },
): Document {
  const kind = workKindOf(id);
  const node = findNode(doc, id);
  if (kind == null || !node || node.absentSince !== undefined) throw new UnknownReferenceError(id, 'a plan, an issue or a spare');
  if (!FIELDS[kind].includes(field)) throw new WorkFieldError(`a ${kind} has no ${field}`);
  let v = value.trim();
  if (field === 'ticket' && v !== '') v = opts.gate(v).trim();
  if (field === 'due' && v !== '' && !isIsoDate(v)) throw new WorkFieldError('a due date is a date, like 2026-11-07');
  if (field === 'assigned_to' && v !== '' && !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(v)) throw new WorkFieldError('assign it to someone from the list');
  if (field === 'ticket' && v.length > 500) throw new WorkFieldError('an outside ticket is a link or a number, at most 500 characters');
  const key = `${kind}.${field}`;
  requireFieldName(key);
  const actor = opts.actor ?? LOCAL_ACTOR;
  const now = opts.now ?? Date.now();
  const existing: FieldEntry | undefined = node.fields[key];
  const prov = assertHand(doc, { assertedAt: now, assertedBy: actor, supersedes: existing?.prov });
  const working = existing !== undefined ? archiveField(prov.doc, id, key, existing) : prov.doc;
  const entry: FieldEntry = v === '' ? { presence: 'absent', prov: prov.id } : { presence: 'set', prov: prov.id, value: text(v) };
  const op: Op = { type: 'set_field', element: id, key, presence: v === '' ? 'absent' : 'set', prov: prov.id };
  const next = replaceNode(working, id, (n) => ({ ...n, fields: { ...n.fields, [key]: entry } }));
  const label = field === 'assigned_to' ? (v ? 'assign work' : 'unassign work') : field === 'due' ? 'set due date' : 'set outside ticket';
  return withBatch(next, { id: newUlid(now), label, ops: [op] });
}

/** How a Fathom number is written, as the server writes it in search: `W-42`. */
export function numberWord(n: number): string {
  return `W-${n}`;
}
