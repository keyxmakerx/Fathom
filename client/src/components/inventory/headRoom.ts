// The room a column needs so its head is never cut short. Pure: no DOM, so the model can use it.
//
// A head is set in capitals at --t-micro (10px) with --track-label (1px after each character), in
// --sans. That stack's first face is Liberation Sans, whose advances are Arial's; the table below
// is Arial's, in thousandths of an em. Measured in a browser on 2026-11-20, Inter, FreeSans (for
// Helvetica) and DejaVu Sans set every built-in head within 4.3% of it, which ALLOW and the spare
// in AROUND cover.

/** --t-micro, in px. */
const EM = 10;
/** --track-label at that size, in px after each character. */
const TRACK = 1;

const ADVANCE = new Map<string, number>([
  ...Object.entries({
    A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833,
    N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
    ' ': 278, '(': 333, ')': 333, '-': 333, '.': 278, ',': 278, ':': 278, ';': 278, '/': 278, '!': 278,
    '[': 278, ']': 278, '&': 667, "'": 191, '"': 355, '+': 584, '=': 584, '<': 584, '>': 584, _: 556,
    '#': 556, '?': 556, '%': 889, '@': 1015, '*': 389,
  }),
  ...Array.from('0123456789', (d): [string, number] => [d, 556]),
]);
/** A character the table does not know is given a full em, which is what a CJK character takes. */
const OTHER = 1000;

/** What a head holds beside its text: 8 of padding before it, 22 for the menu's caret after it,
 * and 23 for a sort mark with its place in a two-key sort ("2▼") and the gap before it. The last
 * 1 is spare. */
const AROUND = 54;
/** The other faces in the stack set the same capitals up to this much wider. */
const ALLOW = 1.04;
/** A very long field name is still cut, with an ellipsis, rather than taking the table over. */
export const HEAD_ROOM_MAX = 260;

/** The width of a head's text in px: its capitals' advances, plus the tracking after each. */
export function headTextWidth(label: string): number {
  let units = 0;
  let count = 0;
  for (const ch of label.toUpperCase()) {
    // An accented capital is as wide as its letter.
    units += ADVANCE.get(ch) ?? ADVANCE.get(ch.normalize('NFD').charAt(0)) ?? OTHER;
    count += 1;
  }
  return (units / 1000) * EM + count * TRACK;
}

/** The least width, in px, at which a column's head shows its whole label, sorted or not. */
export function headRoom(label: string): number {
  return Math.min(HEAD_ROOM_MAX, Math.ceil(headTextWidth(label) * ALLOW) + AROUND);
}
