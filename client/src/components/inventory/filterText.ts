// What is typed in the filter box: `tag:edge` or `Model:ex4300` names a column, plain text means any column.
import type { Column } from './kinds';

export interface ParsedFilter {
  col: string;
  value: string;
}

/** `column:value` when the word before the colon is `tag`/`tags` or a column's label or key
 * (any case); otherwise the whole text, for the column chosen in the menu. */
export function parseFilterText(text: string, columns: readonly Column[], fallbackCol: string): ParsedFilter | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const at = trimmed.indexOf(':');
  if (at > 0) {
    const word = trimmed.slice(0, at).trim().toLowerCase();
    const value = trimmed.slice(at + 1).trim();
    const col = word === 'tag' || word === 'tags' ? columns.find((c) => c.key === 'tags') : columns.find((c) => c.label.toLowerCase() === word || c.key.toLowerCase() === word);
    if (col && value !== '') return { col: col.key, value };
  }
  return { col: fallbackCol, value: trimmed };
}
