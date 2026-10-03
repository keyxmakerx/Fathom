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

/** Records (key to text, in first-seen order) as a table. Keys are Map keys, never object keys. */
export function tableOfRecords(records: ReadonlyArray<ReadonlyMap<string, string>>, notes: string[]): { headers: string[]; rows: string[][] } {
  checkRowCount(records.length);
  const index = new Map<string, number>();
  for (const r of records) {
    for (const k of r.keys()) if (!index.has(k)) index.set(k, index.size);
  }
  // A key with no value in any record (a null in JSON) is not a column; `name` always stays.
  const used = [...index.keys()].filter((k) => k === 'name' || records.some((r) => (r.get(k) ?? '') !== ''));
  if (used.length > LIMITS.columns) notes.push(`Only the first ${LIMITS.columns} of ${used.length} columns were read.`);
  const keys = used.slice(0, LIMITS.columns);
  const rows = records.map((r) => keys.map((k) => r.get(k) ?? ''));
  return { headers: keys, rows };
}
