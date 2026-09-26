// Shared by the CSV and xlsx writers (brief: "one helper for both files") —
// strips what XML 1.0's Char production forbids and cuts a cell at Excel's
// own 32,767-character limit. https://www.w3.org/TR/xml/#charsets: Char ::=
// #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF] —
// so a C0 control other than tab/LF/CR, a lone UTF-16 surrogate, or U+FFFE/
// U+FFFF is dropped; a valid surrogate pair (a supplementary character) is
// always kept.

const CELL_CHAR_LIMIT = 32_767;

function isAllowedBmpCode(code: number): boolean {
  if (code === 0x9 || code === 0xa || code === 0xd) return true;
  if (code >= 0x20 && code <= 0xd7ff) return true;
  if (code >= 0xe000 && code <= 0xfffd) return true;
  return false;
}

/** Drops the forbidden characters only — no length cut. Exported so a
 * caller that adds a prefix afterwards (the CSV writer's injection guard)
 * can cut once, after the prefix, rather than risk landing at 32,768. */
export function stripForbiddenChars(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += input[i] + input[i + 1];
        i += 1;
      }
      // else: a high surrogate with no low surrogate following it — dropped.
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      // A low surrogate reached without a high surrogate just before it —
      // dropped the same way.
      continue;
    }
    if (isAllowedBmpCode(code)) out += input[i];
  }
  return out;
}

/** Cuts to the cell limit without splitting a surrogate pair at the cut
 * point. */
export function cutAtCellLimit(s: string): string {
  if (s.length <= CELL_CHAR_LIMIT) return s;
  let cut = CELL_CHAR_LIMIT;
  const before = s.charCodeAt(cut - 1);
  if (before >= 0xd800 && before <= 0xdbff) cut -= 1;
  return s.slice(0, cut);
}

/** Strip, then cut — the xlsx writer's own order, where nothing is added
 * afterwards. The CSV writer strips, guards, then cuts instead. */
export function cleanExportText(input: string): string {
  return cutAtCellLimit(stripForbiddenChars(input));
}
