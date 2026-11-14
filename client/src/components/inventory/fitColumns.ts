import type { Column } from './kinds';

/** The columns a narrow window can show without the table scrolling sideways: the first column always,
 * clamped to the width if it alone is wider, then each next column while it still fits. The person's own
 * column choice is untouched; this only decides what a phone draws. */
export function fitColumns(columns: readonly Column[], available: number): Column[] {
  const out: Column[] = [];
  let used = 0;
  for (const col of columns) {
    if (out.length === 0) {
      const first = col.width > available ? { ...col, width: Math.max(0, available) } : col;
      out.push(first);
      used = first.width;
    } else if (used + col.width <= available) {
      out.push(col);
      used += col.width;
    } else {
      // Give the last visible column what is left rather than leaving a gap, when that is a usable width.
      const rest = available - used;
      if (rest >= 96) out.push({ ...col, width: rest });
      break;
    }
  }
  return out;
}
