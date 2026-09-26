// The cut sheet's .csv download, with the CSV injection guard OWASP
// describes (owasp.org/www-community/attacks/CSV_Injection, read 2026-09-26).
import { cutAtCellLimit, stripForbiddenChars } from './textClean';

const DANGEROUS_LEADERS = new Set(['=', '+', '-', '@', '\t', '\r', '＝', '＋', '－', '＠']);

/** A single quote ahead of the value when it would otherwise read as a
 * formula; the cell unchanged otherwise. */
export function guardCsvCell(cell: string): string {
  // Unicode whitespace, but not tab or CR — those are dangerous leaders
  // themselves and must be caught, not skipped over.
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
