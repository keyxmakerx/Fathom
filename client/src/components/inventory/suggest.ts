// Suggestions under the filter line while typing: fields first, then a field's values with counts.
// Pure; the caller gives the line, the cursor and what the list holds.

import { BLANK, type Distinct } from './facets';
import { quoteValue, type FieldSpec } from './query';

export interface Suggestion {
  /** What replaces the word being typed. */
  insert: string;
  main: string;
  hint?: string;
  count?: number;
  /** A field name: after it is put in, keep suggesting. */
  isField?: boolean;
}

export interface Suggestions {
  head: string;
  items: Suggestion[];
  /** The word being typed, as a range in the line. */
  start: number;
  end: number;
}

const FIELD_OP = /^([a-z][a-z0-9_.]*)(!=|>=|<=|:|~|\^|>|<)(.*)$/i;
const MAX = 8;

/** The word under the cursor: from after a space, bracket or bar up to the next one. */
export function wordAt(line: string, pos: number): { start: number; end: number } {
  let start = pos;
  while (start > 0 && !/[\s(|]/.test(line[start - 1]!)) start -= 1;
  let end = pos;
  while (end < line.length && !/[\s()|]/.test(line[end]!)) end += 1;
  return { start, end };
}

export function suggestAt(line: string, pos: number, fields: readonly FieldSpec[], values: (field: string) => Distinct): Suggestions | null {
  const { start, end } = wordAt(line, pos);
  const word = line.slice(start, pos);
  const neg = word.startsWith('-') ? '-' : '';
  const body = neg ? word.slice(1) : word;
  const m = FIELD_OP.exec(body);
  const spec = m ? fields.find((f) => f.key.toLowerCase() === m[1]!.toLowerCase()) : undefined;
  if (m && spec) {
    const op = m[2]!;
    const typed = m[3]!.replace(/"/g, '').toLowerCase();
    const dv = values(spec.key);
    const head = `${spec.label} · ${spec.numeric && op !== ':' ? 'a number' : `${dv.n.toLocaleString('en-GB')} values`}`;
    const items: Suggestion[] = [];
    if (!spec.numeric || op === ':') {
      const real = dv.keys.filter((k) => k !== BLANK);
      let ks = real.filter((k) => typed === '' || k.toLowerCase().startsWith(typed));
      if (ks.length < MAX && typed !== '') ks = ks.concat(real.filter((k) => k.toLowerCase().indexOf(typed) > 0));
      for (const k of ks.slice(0, MAX)) items.push({ insert: `${neg}${spec.key}${op}${quoteValue(k)} `, main: k, count: dv.counts.get(k) });
      const blank = dv.counts.get(BLANK);
      if (op === ':' && blank && (typed === '' || 'empty'.startsWith(typed))) items.push({ insert: `${neg}${spec.key}:empty `, main: 'empty', hint: 'no value', count: blank });
    }
    // A value typed out in full needs no suggesting.
    if (items.length === 1 && items[0]!.main.toLowerCase() === typed) return null;
    return items.length ? { head, items, start, end } : null;
  }
  if (/^[a-z0-9_.]*$/i.test(body) && !m) {
    const lo = body.toLowerCase();
    const hit = fields.filter((f) => f.key.toLowerCase().startsWith(lo));
    const more = lo ? fields.filter((f) => !f.key.toLowerCase().startsWith(lo) && (f.key.toLowerCase().includes(lo) || f.label.toLowerCase().includes(lo))) : [];
    const items = [...hit, ...more].slice(0, 10).map((f): Suggestion => ({ insert: `${neg}${f.key}:`, main: f.key, hint: f.label, isField: true }));
    if (!items.length) return null;
    return { head: lo ? 'Fields' : 'Start with a field, or press ? for the full list', items, start, end };
  }
  return null;
}

/** The line with the suggestion put in for the word being typed, and where the cursor goes. */
export function applySuggestion(line: string, s: Suggestions, item: Suggestion): { line: string; cursor: number } {
  const after = line.slice(s.end);
  const glue = item.insert.endsWith(' ') ? after.replace(/^ /, '') : after;
  const next = line.slice(0, s.start) + item.insert + glue;
  return { line: next, cursor: s.start + item.insert.length };
}
