// What every format reduces to: a header row and string rows. Only `gateTable` (gate.ts) makes
// a GatedTable, so the plan and the apply step cannot be handed text the gate has not seen.

import { LIMITS, ImportRefusal } from './limits';
import { oneLine } from './text';

export type SourceKind = 'csv' | 'netbox-csv' | 'netbox-json' | 'proxmox' | 'nmap' | 'json';

export interface RawTable {
  kind: SourceKind;
  /** "NetBox device export, 212 rows". */
  label: string;
  headers: string[];
  rows: string[][];
  /** Things dropped or cut on the way in, for the person to read. */
  notes: string[];
}

declare const gatedBrand: unique symbol;

export interface GatedTable {
  readonly [gatedBrand]: true;
  kind: SourceKind;
  label: string;
  headers: string[];
  rows: string[][];
  notes: string[];
  /** Cells kept as text because they began with = + - @. */
  neutralised: number;
  /** Cells cut at the cell cap. */
  truncated: number;
}

/** Header names made unique, non-empty and bounded. */
export function cleanHeaders(headers: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return headers.slice(0, LIMITS.columns).map((h, i) => {
    let name = oneLine(h).slice(0, 100) || `column ${i + 1}`;
    const key = name.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > 1) name = `${name} (${n})`;
    return name;
  });
}

export function checkRowCount(n: number): void {
  if (n > LIMITS.rows) {
    throw new ImportRefusal(`This file has more than ${LIMITS.rows} rows. Split it and import the parts one at a time.`);
  }
}

/** Keys read before further ones are ignored; a record of thousands of keys cannot make this slow. */
const KEY_SCAN = 3 * LIMITS.columns;

/** Records (key to text, in first-seen order) as a table. Keys are Map keys, never object keys. */
export function tableOfRecords(records: ReadonlyArray<ReadonlyMap<string, string>>, notes: string[]): { headers: string[]; rows: string[][] } {
  checkRowCount(records.length);
  const index = new Set<string>();
  const filled = new Set<string>();
  for (const r of records) {
    for (const [k, v] of r) {
      if (!index.has(k)) {
        // Past the scan cap only `name` is still taken.
        if (index.size >= KEY_SCAN && k !== 'name') continue;
        index.add(k);
      }
      if (v !== '') filled.add(k);
    }
  }
  // A key with no value in any record (a null in JSON) is not a column; `name` always stays.
  const used = [...index].filter((k) => k === 'name' || filled.has(k));
  if (used.length > LIMITS.columns) notes.push(`Only the first ${LIMITS.columns} of ${used.length} columns were read.`);
  const keys = used.slice(0, LIMITS.columns);
  if (used.includes('name') && !keys.includes('name')) keys[keys.length - 1] = 'name';
  const rows = records.map((r) => keys.map((k) => r.get(k) ?? ''));
  return { headers: keys, rows };
}
