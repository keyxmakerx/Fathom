// The cut sheet's .csv download. OWASP CSV Injection
// (owasp.org/www-community/attacks/CSV_Injection, read 2026-09-26): a cell a
// spreadsheet opens as a formula if it starts with =, +, -, @, a tab or a
// carriage return; OWASP's fix is a leading single quote. Checked after
// leading whitespace too (space, no-break space U+00A0, vertical tab
// U+000B) and for the full-width forms of those five signs (U+FF1D, U+FF0B,
// U+FF0D, U+FF20) — Excel trims and folds both before it decides whether a
// cell opens with one.
import { cleanExportText } from './textClean';

const DANGEROUS_LEADERS = new Set(['=', '+', '-', '@', '\t', '\r', '＝', '＋', '－', '＠']);
const LEADING_WHITESPACE = new Set([' ', ' ', '\u000B']);

function stripLeadingWhitespace(s: string): string {
  let i = 0;
  while (i < s.length && LEADING_WHITESPACE.has(s[i])) i += 1;
  return s.slice(i);
}

/** A single quote ahead of the value when it would otherwise read as a
 * formula; the cell unchanged otherwise. */
export function guardCsvCell(cell: string): string {
  const probe = stripLeadingWhitespace(cell);
  if (probe.length > 0 && DANGEROUS_LEADERS.has(probe[0])) return `'${cell}`;
  return cell;
}

function escapeCsvField(raw: string): string {
  const guarded = guardCsvCell(cleanExportText(raw));
  if (/[",\n\r]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

/** CRLF rows, a UTF-8 BOM first so Excel on Windows reads "—" and "·"
 * correctly rather than guessing the wrong code page. */
export function buildCsv(rows: readonly (readonly string[])[]): Uint8Array {
  const body = rows.map((row) => row.map(escapeCsvField).join(',')).join('\r\n');
  const text = '﻿' + body + (rows.length > 0 ? '\r\n' : '');
  return new TextEncoder().encode(text);
}
