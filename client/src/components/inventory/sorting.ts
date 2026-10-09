// Sorting the Inventory list by one column, or by several (a shift-click adds the next one). Pure.

import type { InvRow } from './kinds';
import type { SortKey } from './listState';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compare(a: InvRow, b: InvRow, key: string): number {
  const x = a.sort?.[key] ?? a.nums?.[key];
  const y = b.sort?.[key] ?? b.nums?.[key];
  if (x !== undefined && y !== undefined) return x - y;
  const ax = a.cells[key] ?? '';
  const bx = b.cells[key] ?? '';
  // Blanks sort first going up, last going down, like a number's missing value.
  if (ax === '' || bx === '') return ax === bx ? 0 : ax === '' ? -1 : 1;
  return collator.compare(ax, bx);
}

export function sortRows(rows: readonly InvRow[], sorts: readonly SortKey[]): InvRow[] {
  if (sorts.length === 0) return rows as InvRow[];
  return [...rows].sort((a, b) => {
    for (const s of sorts) {
      const c = compare(a, b, s.key);
      if (c !== 0) return s.dir === 'asc' ? c : -c;
    }
    return 0;
  });
}

/** A plain click: the column alone, up, then down, then off. A shift-click: add it after the others, or flip it. */
export function nextSorts(sorts: readonly SortKey[], key: string, additive: boolean): SortKey[] {
  const at = sorts.findIndex((s) => s.key === key);
  if (additive) {
    if (at < 0) return [...sorts, { key, dir: 'asc' }];
    return sorts.map((s, i) => (i === at ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : s));
  }
  if (sorts.length === 1 && at === 0) return sorts[0]!.dir === 'asc' ? [{ key, dir: 'desc' }] : [];
  return [{ key, dir: 'asc' }];
}

/** The column's menu: sort this way (or off), on its own or after the others. */
export function setSort(sorts: readonly SortKey[], key: string, dir: 'asc' | 'desc' | null, additive: boolean): SortKey[] {
  const rest = additive ? sorts.filter((s) => s.key !== key) : [];
  return dir === null ? rest : [...rest, { key, dir }];
}
