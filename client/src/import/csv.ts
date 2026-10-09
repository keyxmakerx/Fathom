// CSV or TSV (also semicolon) with caps. A cell may hold quoted commas, quotes and line breaks.

import { LIMITS, ImportRefusal } from './limits';

function pickDelimiter(src: string): string {
  const end = src.indexOf('\n');
  const line = end < 0 ? src : src.slice(0, end);
  let best = ',';
  let bestN = 0;
  for (const d of ['\t', ',', ';']) {
    let n = 0;
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === d) n += 1;
    }
    if (n > bestN) {
      best = d;
      bestN = n;
    }
  }
  return best;
}

export interface Delimited {
  delimiter: string;
  rows: string[][];
  /** Cells beyond the header's width, dropped. */
  extraCells: number;
}

/** Stops with a refusal as soon as the row or column cap is passed. Blank lines are skipped. */
export function parseDelimited(text: string): Delimited {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const delimiter = pickDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let started = false;
  const endCell = () => {
    row.push(cell);
    if (row.length > LIMITS.columns + 50) throw new ImportRefusal(`A row has more than ${LIMITS.columns} columns, which is not a device list.`);
    cell = '';
    started = false;
  };
  const endRow = () => {
    endCell();
    if (row.some((c) => c.trim() !== '')) {
      rows.push(row);
      if (rows.length > LIMITS.rows + 1) {
        throw new ImportRefusal(`This file has more than ${LIMITS.rows} rows. Split it and import the parts one at a time.`);
      }
    }
    row = [];
  };
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && !started) {
      quoted = true;
      started = true;
    } else if (ch === delimiter) {
      endCell();
    } else if (ch === '\n') {
      endRow();
    } else {
      cell += ch;
      started = true;
    }
  }
  if (quoted) throw new ImportRefusal('A quoted cell is never closed, so this is not a well-formed CSV file.');
  if (cell !== '' || row.length > 0) endRow();

  const width = rows[0]?.length ?? 0;
  let extraCells = 0;
  const fixed = rows.map((r) => {
    if (r.length > width) extraCells += r.length - width;
    return r.length === width ? r : r.length > width ? r.slice(0, width) : [...r, ...new Array<string>(width - r.length).fill('')];
  });
  return { delimiter, rows: fixed, extraCells };
}
