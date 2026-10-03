// Making text from a file safe to keep. Imported strings are only ever shown as React text.

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// C0/C1 controls except tab and newline; zero-width, bidi marks, embeddings, isolates and BOM.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

/** Control, bidi and zero-width characters out; CR and U+2028/9 become newlines; tabs a space. */
export function stripUnsafe(s: string): string {
  return s
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/\t/g, ' ')
    .replace(UNSAFE, '')
    .replace(LONE_SURROGATE, '\uFFFD');
}

/** One line: whitespace runs collapse to a single space. */
export function oneLine(s: string): string {
  return stripUnsafe(s).replace(/\s+/g, ' ').trim();
}

/** Cut to `max` code points without splitting a pair. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

const PURE_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * A spreadsheet runs a cell that starts with = + - @ (or a tab or CR) as a formula, so a later
 * export could execute it. Such a cell is kept as text with a leading apostrophe. A plain number
 * such as -5 is left alone. `raw` is the cell before cleaning, since cleaning drops a leading tab.
 */
export function neutraliseFormula(raw: string, cleaned: string): { text: string; changed: boolean } {
  const lead = /^[=+\-@]/.test(cleaned) || /^[\t\r]/.test(raw);
  if (!lead || PURE_NUMBER.test(cleaned)) return { text: cleaned, changed: false };
  return { text: `'${cleaned}`, changed: true };
}

/** A hostname the schema's Identifier takes: printable ASCII, no space. Spaces become '-'. */
export function toHostname(raw: string): string | null {
  const s = oneLine(raw).replace(/ /g, '-');
  return /^[\x21-\x7E]{1,253}$/.test(s) ? s : null;
}

/** Serial: the same Identifier rule, but a space is refused rather than rewritten. */
export function toSerial(raw: string): string | null {
  const s = oneLine(raw);
  return /^[\x21-\x7E]{1,253}$/.test(s) ? s : null;
}

export function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
