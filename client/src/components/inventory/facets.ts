// Counting what a field holds: the Filters panel, the "?" help examples, the suggestions while
// typing and the column menus all list values with how many rows carry them. Pure.

import type { InvRow } from './kinds';
import { probeOf, type QuerySchema } from './rowQuery';

export const BLANK = '(blank)';

export interface Distinct {
  counts: ReadonlyMap<string, number>;
  /** Most common first, then in natural order. */
  keys: string[];
  /** How many different values (blank counts as one). */
  n: number;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Each row counts once per value it holds. Stops listing keys past `limit` values but keeps counting n. */
export function distinctOf(rows: readonly InvRow[], schema: QuerySchema, field: string, limit = Infinity): Distinct {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const vs = probeOf(schema, row).values(field);
    const seen = new Set<string>();
    for (const raw of vs) {
      const v = raw === '' ? BLANK : raw;
      if (seen.has(v)) continue;
      seen.add(v);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  const keys = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)! || collator.compare(a, b));
  return { counts, keys: keys.length > limit ? keys.slice(0, limit) : keys, n: counts.size };
}

/** More distinct values than this and a list stops helping: ask for a typed condition instead. */
export const TOO_MANY = 200;
/** The Filters panel lists up to this many as checkboxes, then offers "contains". */
export const PANEL_LIMIT = 60;
