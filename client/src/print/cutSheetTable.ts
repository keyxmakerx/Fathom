// The cut sheet as a flat table — the shape the .csv/.xlsx downloads and the
// printed pages both read off, so there is exactly one grouping rule to get
// right. One column-title row at the very top, and one bold, filled row per
// device (name, model, placement) ahead of its own port rows.
import type { CutSheetDevice } from './cutSheet';

export const CUT_SHEET_COLUMNS = ['Device', 'Model', 'Placement', 'Port', 'Connector', 'Far end', 'Cable', 'Colour', 'VLANs'] as const;

export interface CutSheetTableRow {
  cells: string[];
  bold: boolean;
}

export function cutSheetColumnHeaderRow(): CutSheetTableRow {
  return { cells: [...CUT_SHEET_COLUMNS], bold: true };
}

function deviceHeaderRow(d: CutSheetDevice): CutSheetTableRow {
  return { cells: [d.name, d.model, d.placement, '', '', '', '', '', ''], bold: true };
}

function portRow(r: CutSheetDevice['rows'][number]): CutSheetTableRow {
  return { cells: ['', '', '', r.port, r.connector, r.farEnd, r.cable, r.colour, r.vlans], bold: false };
}

export interface CutSheetBodyRow {
  row: CutSheetTableRow;
  isDeviceHeader: boolean;
}

/** Every row after the column header, one device after another, no paging
 * — a device header marked so a page split can repeat it. */
export function cutSheetBodyRows(devices: readonly CutSheetDevice[]): CutSheetBodyRow[] {
  const rows: CutSheetBodyRow[] = [];
  for (const d of devices) {
    rows.push({ row: deviceHeaderRow(d), isDeviceHeader: true });
    for (const r of d.rows) rows.push({ row: portRow(r), isDeviceHeader: false });
  }
  return rows;
}

/** Every row, flat, no paging — what the .csv/.xlsx downloads write. */
export function cutSheetTableRows(devices: readonly CutSheetDevice[]): CutSheetTableRow[] {
  return [cutSheetColumnHeaderRow(), ...cutSheetBodyRows(devices).map((r) => r.row)];
}

/**
 * Packs measured rows into pages: every page opens with the column header,
 * repeated at `columnHeader.heightPx`; a device whose ports run past a page
 * boundary repeats its own header row on the next page. Pure — fed
 * fabricated heights in its own tests, real ones from a hidden render in
 * `PrintPreview.tsx`.
 */
export function paginateCutSheetByHeight(
  columnHeader: { row: CutSheetTableRow; heightPx: number },
  bodyRows: readonly { row: CutSheetTableRow; isDeviceHeader: boolean; heightPx: number }[],
  capacityPx: number,
): CutSheetTableRow[][] {
  const pages: CutSheetTableRow[][] = [];
  let current: CutSheetTableRow[] = [columnHeader.row];
  let used = columnHeader.heightPx;
  let activeHeader: { row: CutSheetTableRow; heightPx: number } | null = null;

  function newPage() {
    pages.push(current);
    current = [columnHeader.row];
    used = columnHeader.heightPx;
    if (activeHeader) {
      current.push(activeHeader.row);
      used += activeHeader.heightPx;
    }
  }

  for (const u of bodyRows) {
    if (u.isDeviceHeader) activeHeader = null; // a new device — nothing of its own to replay yet
    if (used + u.heightPx > capacityPx && current.length > 1) newPage();
    current.push(u.row);
    used += u.heightPx;
    if (u.isDeviceHeader) activeHeader = { row: u.row, heightPx: u.heightPx };
  }
  pages.push(current);
  return pages;
}
