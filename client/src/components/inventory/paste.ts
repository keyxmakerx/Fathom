// Pasting rows from a spreadsheet into the Inventory table (ADR-0062). Pure: parse TSV or CSV,
// then plan which existing rows are updated and which new things are added. The caller runs every
// cell through the redaction gate first (CLAUDE.md rule 4: pasted text is gated, typed is not).

import type { Column, InvRow } from './kinds';

/** Splits `text` into rows of cells. Tab-separated when the first line has a tab, else comma. */
export function parseTable(text: string): string[][] {
  const src = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  const firstLine = src.split('\n', 1)[0] ?? '';
  const sep = firstLine.includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const endCell = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        quoted = false;
        i += 1;
        continue;
      }
      cell += ch;
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === sep) {
      endCell();
    } else if (ch === '\n') {
      endRow();
    } else {
      cell += ch;
    }
    i += 1;
  }
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}

export interface PlannedEdit {
  col: Column;
  value: string;
}

export interface PastePlan {
  /** The columns the pasted cells map to, in order (null: an ignored column). */
  mapped: Array<Column | null>;
  ignoredHeaders: string[];
  updates: Array<{ row: InvRow; edits: PlannedEdit[] }>;
  adds: Array<{ name: string; edits: PlannedEdit[] }>;
  /** Rows with no name, or a new name on a kind that cannot add one. */
  skipped: number;
}

/**
 * `columns` are the editable columns of the kind (the visible ones first, in order). The first
 * pasted row is a header when every non-blank cell names a column; otherwise the cells map to
 * `columns` left to right. A row is matched to an existing one by its Name; an empty pasted cell
 * leaves the value alone rather than clearing it.
 */
export function planPaste(
  table: string[][],
  columns: readonly Column[],
  rows: readonly InvRow[],
  opts: { canAdd: boolean },
): PastePlan {
  const byLabel = new Map<string, Column>();
  for (const c of columns) byLabel.set(c.label.toLowerCase().replace(/\s*\(.*\)$/, ''), c);
  for (const c of columns) byLabel.set(c.label.toLowerCase(), c);
  const nameCol = columns.find((c) => c.key === 'name');
  if (nameCol) byLabel.set('name', nameCol);

  const first = table[0] ?? [];
  // A header row is one that names the Name column; its other cells may be unknown (ignored).
  const hasHeader = first.some((c) => nameCol != null && byLabel.get(c.trim().toLowerCase()) === nameCol);
  const ignoredHeaders: string[] = [];
  let mapped: Array<Column | null>;
  let body: string[][];
  if (hasHeader) {
    mapped = first.map((h) => byLabel.get(h.trim().toLowerCase()) ?? null);
    body = table.slice(1);
  } else {
    mapped = columns.slice(0, Math.max(...table.map((r) => r.length), 0));
    body = table;
  }

  const nameIndex = mapped.findIndex((c) => c?.key === 'name');
  const existing = new Map<string, InvRow>();
  for (const r of rows) {
    const n = (r.cells.name ?? '').trim().toLowerCase();
    if (n && !existing.has(n)) existing.set(n, r);
  }

  const plan: PastePlan = { mapped, ignoredHeaders, updates: [], adds: [], skipped: 0 };
  const seenNew = new Map<string, number>();
  for (const cells of body) {
    const name = nameIndex >= 0 ? (cells[nameIndex] ?? '').trim() : '';
    if (!nameCol || !name) {
      plan.skipped += 1;
      continue;
    }
    const edits: PlannedEdit[] = [];
    mapped.forEach((col, i) => {
      if (!col || col.key === 'name' || !col.editable) return;
      const value = (cells[i] ?? '').trim();
      if (value === '') return;
      edits.push({ col, value });
    });
    const match = existing.get(name.toLowerCase());
    if (match) {
      const changed = edits.filter((e) => (match.cells[e.col.key] ?? '') !== e.value);
      if (changed.length > 0) plan.updates.push({ row: match, edits: changed });
    } else if (opts.canAdd) {
      const at = seenNew.get(name.toLowerCase());
      if (at !== undefined) plan.adds[at]!.edits.push(...edits);
      else {
        seenNew.set(name.toLowerCase(), plan.adds.length);
        plan.adds.push({ name, edits });
      }
    } else {
      plan.skipped += 1;
    }
  }
  if (hasHeader) {
    first.forEach((h, i) => {
      if (mapped[i] === null && h.trim()) plan.ignoredHeaders.push(h.trim());
    });
  }
  return plan;
}
