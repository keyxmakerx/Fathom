// Making text from a file safe to keep. Imported strings are only ever shown as React text.

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// The server's deny set (field_defs.rs is_unsafe_char) except newline, which notes keep: C0/C1
// controls, soft hyphen, fillers, bidi and zero-width marks, variation selectors, private use, tags.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u00AD\u034F\u061C\u0600-\u0605\u115F\u1160\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\uE000-\uF8FF\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\u{1D173}-\u{1D17A}\u{E0000}-\u{E0FFF}\u{F0000}-\u{10FFFF}]/gu;

/** The server's invisible and control characters out; CR and U+2028/9 become newlines; tabs a space. */
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

// ASCII leaders and their fullwidth forms.
const FORMULA_LEAD = /^[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/;

/**
 * A spreadsheet runs a cell that starts with = + - @ (or a tab or CR) as a formula, so a later
 * export could execute it. Such a cell is kept as text with a leading apostrophe. A plain number
 * such as -5 is left alone. `raw` is the cell before cleaning, since cleaning drops a leading tab;
 * the leader is looked for after invisible characters and leading space are gone.
 */
export function neutraliseFormula(raw: string, cleaned: string): { text: string; changed: boolean } {
  const probe = stripUnsafe(cleaned).trimStart();
  const lead = FORMULA_LEAD.test(probe) || /^[\t\r]/.test(raw);
  if (!lead || PURE_NUMBER.test(probe.trimEnd())) return { text: cleaned, changed: false };
  return { text: `'${cleaned}`, changed: true };
}

/** One list element (a tag) made safe the same way, once the list has been split. */
export function neutraliseElement(s: string): string {
  return neutraliseFormula(s, s).text;
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
