// The cut sheet as a flat table — the shape the .csv/.xlsx downloads and the
// printed pages both read off, so there is exactly one grouping rule to get
// right. Brief item 5: "one worksheet, a header row, bold device header
// rows" — one column-title row at the very top, and one bold row per
// device (name, model, placement) ahead of its own port rows.
import { contentHeightMm, type PaperSize } from './paper';
import { TABLE_ROW_MM } from './rackSheet';
import type { CutSheetDevice } from './cutSheet';

export const CUT_SHEET_COLUMNS = ['Device', 'Model', 'Placement', 'Port', 'Connector', 'Far end', 'Cable', 'Colour', 'VLANs'] as const;

export interface CutSheetTableRow {
  cells: string[];
  bold: boolean;
}

function headerRow(): CutSheetTableRow {
  return { cells: [...CUT_SHEET_COLUMNS], bold: true };
}

function deviceHeaderRow(d: CutSheetDevice, continued = false): CutSheetTableRow {
  return { cells: [continued ? `${d.name} (continued)` : d.name, d.model, d.placement, '', '', '', '', '', ''], bold: true };
}

function portRow(r: CutSheetDevice['rows'][number]): CutSheetTableRow {
  return { cells: ['', '', '', r.port, r.connector, r.farEnd, r.cable, r.colour, r.vlans], bold: false };
}

/** Every row, one device after another, no paging — what the .csv/.xlsx
 * downloads write. */
export function cutSheetTableRows(devices: readonly CutSheetDevice[]): CutSheetTableRow[] {
  const rows: CutSheetTableRow[] = [headerRow()];
  for (const d of devices) {
    rows.push(deviceHeaderRow(d));
    for (const r of d.rows) rows.push(portRow(r));
  }
  return rows;
}

/** How many table rows (the column-title row not counted — every page
 * repeats it on top of this) fit in one page's content height. */
export function cutSheetRowsPerPage(paper: PaperSize): number {
  return Math.max(5, Math.floor(contentHeightMm(paper) / TABLE_ROW_MM) - 1);
}

/**
 * Cut into pages of at most `cutSheetRowsPerPage(paper)` content rows —
 * every page opens with the column-title row; a device whose ports run
 * past a page boundary repeats its own header, marked "(continued)", on
 * the next page rather than leaving its later ports unlabelled.
 */
export function paginateCutSheet(devices: readonly CutSheetDevice[], paper: PaperSize): CutSheetTableRow[][] {
  const capacity = cutSheetRowsPerPage(paper);
  const pages: CutSheetTableRow[][] = [];
  let current: CutSheetTableRow[] = [headerRow()];

  function roomLeft(): number {
    return capacity - (current.length - 1);
  }
  function newPage() {
    pages.push(current);
    current = [headerRow()];
  }

  for (const d of devices) {
    if (roomLeft() <= 0) newPage();
    current.push(deviceHeaderRow(d));
    for (const r of d.rows) {
      if (roomLeft() <= 0) {
        newPage();
        current.push(deviceHeaderRow(d, true));
      }
      current.push(portRow(r));
    }
  }
  pages.push(current);
  return pages;
}
