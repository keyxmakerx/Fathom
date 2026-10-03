// Joins the query language to Inventory rows: which fields a kind has, how a row answers about a
// field, and filtering a list by the line. Pure.

import type { Column, InvRow } from './kinds';
import { compileQuery, parseQuery, type FieldSpec, type Parsed, type Probe } from './query';

/** A field a column does not show but the line can ask about. */
export interface FacetSpec extends FieldSpec {
  /** Shown in the Filters panel and the "?" help. */
  hint?: string;
}

export interface QuerySchema {
  kindWord: string;
  fields: FieldSpec[];
  /** query key -> the cell key it reads (facets read `row.facets[key]` first). */
  cellOf: ReadonlyMap<string, string>;
  labelOf: (field: string) => string;
}

const NUMERIC_CORE = new Set(['height', 'bay', 'length', 'devices', 'members', 'vlan', 'used', 'free', 'ports_count']);

export function slug(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(s) ? s : `f_${s}`;
}

/** The word to type for a column: its key, or the field's name for a custom field. */
export function queryKeyOf(col: Column, taken: ReadonlySet<string>): string {
  if (!col.key.startsWith('field:')) return col.key;
  let k = slug(col.label);
  while (taken.has(k)) k = `${k}_2`;
  return k;
}

export function schemaFor(kindWord: string, columns: readonly Column[], facets: readonly FacetSpec[] = []): QuerySchema {
  const fields: FieldSpec[] = [];
  const cellOf = new Map<string, string>();
  const taken = new Set<string>([...columns.filter((c) => !c.key.startsWith('field:')).map((c) => c.key), ...facets.map((f) => f.key)]);
  for (const c of columns) {
    const key = queryKeyOf(c, taken);
    if (key !== c.key) taken.add(key);
    cellOf.set(key, c.key);
    fields.push({ key, label: c.label, numeric: c.type === 'number' || NUMERIC_CORE.has(c.key) });
  }
  for (const f of facets) {
    if (fields.some((x) => x.key === f.key)) continue;
    fields.push(f);
  }
  const labels = new Map(fields.map((f) => [f.key, f.label]));
  return { kindWord, fields, cellOf, labelOf: (f) => labels.get(f) ?? f };
}

const textCache = new WeakMap<InvRow, string>();
function rowText(row: InvRow): string {
  let t = textCache.get(row);
  if (t === undefined) {
    t = Object.values(row.cells).join(' ');
    if (row.facets) for (const v of Object.values(row.facets)) t += ' ' + v.join(' ');
    textCache.set(row, t);
  }
  return t;
}

export function probeOf(schema: QuerySchema, row: InvRow): Probe {
  return {
    values(field) {
      const f = row.facets?.[field];
      if (f) return f;
      if (field === 'tags') return row.tags.length ? row.tags : [''];
      const cell = schema.cellOf.get(field);
      return [cell ? (row.cells[cell] ?? '') : ''];
    },
    number(field) {
      const n = row.nums?.[field];
      if (n !== undefined) return n;
      const cell = schema.cellOf.get(field);
      const raw = cell ? (row.cells[cell] ?? '') : '';
      if (raw === '') return undefined;
      const x = Number(raw);
      return Number.isFinite(x) ? x : undefined;
    },
    text: () => rowText(row),
  };
}

export interface Filtered {
  rows: InvRow[];
  parsed: Parsed;
}

export function filterRows(rows: readonly InvRow[], schema: QuerySchema, q: string): Filtered {
  const parsed = parseQuery(q, schema.fields, schema.kindWord);
  if (parsed.terms.length === 0) return { rows: rows as InvRow[], parsed };
  const keep = compileQuery(parsed.terms, schema.fields);
  return { rows: rows.filter((r) => keep(probeOf(schema, r))), parsed };
}
