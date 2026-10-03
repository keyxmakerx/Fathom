// The Inventory page of the print pack: the table as the person sees it, with its columns and filters.
import type { TableSheetUnpaginated } from './printJob';

const ABSENT = '—';
/** Columns that carry a serial or a management address; "hide sensitive" leaves them out. */
const SENSITIVE_COLUMNS: ReadonlySet<string> = new Set(['serial', 'mgmt']);

export interface InventoryPrintColumn {
  key: string;
  label: string;
  /** The on-screen width in px; only the proportions are used. */
  width: number;
}

export interface InventoryPrintable {
  kindLabel: string;
  columns: readonly InventoryPrintColumn[];
  /** The rows after filters and sort, in on-screen order. */
  rows: readonly { key: string; cells: Readonly<Record<string, string>> }[];
  /** The filters in force, in words, e.g. `Tags: edge`. */
  filterWords: readonly string[];
}

/** Whole percentages summing to exactly 100, in proportion to `widths`. */
export function percentWidths(widths: readonly number[]): number[] {
  const total = widths.reduce((a, b) => a + b, 0) || 1;
  const out = widths.map((w) => Math.max(1, Math.floor((w / total) * 100)));
  let spare = 100 - out.reduce((a, b) => a + b, 0);
  for (let i = 0; spare > 0 && out.length > 0; i = (i + 1) % out.length, spare -= 1) out[i]! += 1;
  for (let i = 0; spare < 0 && out.length > 0; i = (i + 1) % out.length) {
    if (out[i]! > 1) {
      out[i]! -= 1;
      spare += 1;
    }
  }
  return out;
}

export function buildInventorySheet(printable: InventoryPrintable, hideSensitive: boolean): TableSheetUnpaginated {
  const columns = printable.columns.filter((c) => !(hideSensitive && SENSITIVE_COLUMNS.has(c.key)));
  const filters = printable.filterWords.length > 0 ? ` · filtered: ${printable.filterWords.join(', ')}` : '';
  return {
    kind: 'table',
    section: 'inventory',
    widths: percentWidths(columns.map((c) => c.width)),
    columnHeader: { cells: columns.map((c) => c.label), bold: true },
    bodyRows: printable.rows.map((r) => ({
      isDeviceHeader: false,
      key: r.key,
      row: { bold: false, cells: columns.map((c) => (r.cells[c.key] ?? '').trim() || ABSENT) },
    })),
    heading: {
      title: `Inventory · ${printable.kindLabel}`,
      detail: `${printable.rows.length} row${printable.rows.length === 1 ? '' : 's'}${filters}`,
    },
  };
}
