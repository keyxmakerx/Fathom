// The cut sheet's .csv download. OWASP CSV Injection
// (owasp.org/www-community/attacks/CSV_Injection, read 2026-09-26): a cell a
// spreadsheet opens as a formula if it starts with =, +, -, @, a tab or a
// carriage return; OWASP's fix is a leading single quote. Checked after
// leading whitespace too — any Unicode whitespace (JS `\s`, so U+00A0,
// U+2003, U+3000, U+FEFF and a leading newline all count, not only plain
// space) — and for the full-width forms of those five signs (U+FF1D,
// U+FF0B, U+FF0D, U+FF20), since Excel trims and folds both before it
// decides whether a cell opens with one.
import { cutAtCellLimit, stripForbiddenChars } from './textClean';

const DANGEROUS_LEADERS = new Set(['=', '+', '-', '@', '\t', '\r', '＝', '＋', '－', '＠']);

/** A single quote ahead of the value when it would otherwise read as a
 * formula; the cell unchanged otherwise. */
export function guardCsvCell(cell: string): string {
  // Unicode whitespace, but not tab or CR — those are dangerous leaders in
  // their own right (OWASP's own list) and must still be caught as one,
  // never skipped over as if they were merely leading space.
  const probe = cell.replace(/^[^\S\t\r]+/, '');
  if (probe.length > 0 && DANGEROUS_LEADERS.has(probe[0])) return `'${cell}`;
  return cell;
}

/** Strip, guard, THEN cut — a quote the guard adds must still land inside
 * the 32,767 limit, not push a cell to 32,768. */
function escapeCsvField(raw: string): string {
  const cut = cutAtCellLimit(guardCsvCell(stripForbiddenChars(raw)));
  if (/[",\n\r]/.test(cut)) {
    return `"${cut.replace(/"/g, '""')}"`;
  }
  return cut;
}

/** CRLF rows, a UTF-8 BOM first so Excel on Windows reads "—" and "·"
 * correctly rather than guessing the wrong code page. */
export function buildCsv(rows: readonly (readonly string[])[]): Uint8Array {
  const body = rows.map((row) => row.map(escapeCsvField).join(',')).join('\r\n');
  const text = '﻿' + body + (rows.length > 0 ? '\r\n' : '');
  return new TextEncoder().encode(text);
}
