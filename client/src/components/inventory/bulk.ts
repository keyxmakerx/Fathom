// A bulk change made visible before it is made: which rows would change, from what to what, and how
// many already say it. Applying it is one undo step. Pure; the document is written by the caller.

import { collapseBatches } from '../../document/collapse';
import { applyCellEdits, type CellEdit, type Column, type EditContext, type InvRow } from './kinds';
import type { Document } from '../../document/model';

export interface BulkLine {
  row: InvRow;
  before: string;
  after: string;
}

export interface BulkPlan {
  /** In words: "Set Role to firewall". */
  title: string;
  col: Column;
  lines: BulkLine[];
  /** Rows that already have the value. */
  same: number;
  edits: CellEdit[];
}

const tagText = (tags: readonly string[]): string => tags.join(', ');

export function planSet(rows: readonly InvRow[], col: Column, value: string): BulkPlan {
  const after = value.trim();
  const lines: BulkLine[] = [];
  let same = 0;
  for (const row of rows) {
    const before = row.cells[col.key] ?? '';
    if (before === after) same += 1;
    else lines.push({ row, before, after });
  }
  const title = after === '' ? `Clear ${col.label}` : `Set ${col.label} to ${after}`;
  return { title, col, lines, same, edits: lines.map((l) => ({ row: l.row, col, value: after })) };
}

export function planTag(rows: readonly InvRow[], tagsCol: Column, name: string, mode: 'add' | 'remove'): BulkPlan {
  const tag = name.trim().replace(/\s+/g, ' ');
  const key = tag.toLowerCase();
  const lines: BulkLine[] = [];
  let same = 0;
  for (const row of rows) {
    const has = row.tags.some((t) => t.toLowerCase() === key);
    if (mode === 'add' ? has : !has) {
      same += 1;
      continue;
    }
    const next = mode === 'add' ? [...row.tags, tag] : row.tags.filter((t) => t.toLowerCase() !== key);
    lines.push({ row, before: tagText(row.tags), after: tagText(next) });
  }
  const edits = lines.map((l) => ({ row: l.row, col: tagsCol, value: l.after }));
  return { title: `${mode === 'add' ? 'Add' : 'Remove'} tag ${tag}`, col: tagsCol, lines, same, edits };
}

export interface BulkResult {
  doc: Document;
  refused: string[];
  changed: number;
  /** The one batch to undo; null when nothing was written. */
  batchId: string | null;
}

/** Writes the plan as one undo step (if the edits were made by one account), naming what it did. */
export function applyPlan(doc: Document, kind: Parameters<typeof applyCellEdits>[1], plan: BulkPlan, ctx: EditContext): BulkResult {
  const r = applyCellEdits(doc, kind, plan.edits, ctx);
  if (r.doc === doc) return { ...r, batchId: null };
  let next = r.doc;
  if (ctx.actor) {
    try {
      next = collapseBatches(doc, r.doc, `${plan.title} on ${r.changed}`);
    } catch {
      next = r.doc;
    }
  }
  return { doc: next, refused: r.refused, changed: r.changed, batchId: next.batches.length > doc.batches.length ? next.batches[next.batches.length - 1]!.id : null };
}

/** Rows a dry run is cheap for; beyond this the preview says refusals are found as it applies. */
export const DRY_RUN_LIMIT = 300;

/** What would be refused, found without writing. Null when there are too many edits to try. */
export function dryRun(doc: Document, kind: Parameters<typeof applyCellEdits>[1], plan: BulkPlan, ctx: EditContext): string[] | null {
  if (plan.edits.length > DRY_RUN_LIMIT) return null;
  return applyCellEdits(doc, kind, plan.edits, ctx).refused;
}

/** What the bulk bar asked for, kept apart from the rows so it can be re-planned against the live selection. */
export type BulkSpec = { mode: 'set' | 'add-tag' | 'remove-tag'; col: Column; value: string };

/** The plan for `spec` over exactly `rows`: call it again whenever the selection or the list moves. */
export function planFor(spec: BulkSpec, rows: readonly InvRow[]): BulkPlan {
  if (spec.mode === 'set') return planSet(rows, spec.col, spec.value);
  return planTag(rows, spec.col, spec.value, spec.mode === 'add-tag' ? 'add' : 'remove');
}

/** `plan` without any row outside `keys`: the last guard before a write, so an unticked row is never changed. */
export function keepSelected(plan: BulkPlan, keys: ReadonlySet<string>): BulkPlan {
  const lines = plan.lines.filter((l) => keys.has(l.row.key));
  return { ...plan, lines, edits: plan.edits.filter((e) => keys.has(e.row.key)) };
}

/** True while the bulk batch is in the history and nothing has reversed it (the header's Undo does). */
export function bulkStillUndoable(doc: Document, batchId: string): boolean {
  if (!doc.batches.some((b) => b.id === batchId)) return false;
  return !doc.batches.some((b) => b.reverses === batchId);
}
