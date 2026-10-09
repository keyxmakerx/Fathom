// The sums under a list: what the shown rows add up to. Pure.

import type { InvRow, Kind } from './kinds';

export interface Total {
  label: string;
  value: string;
}

const fmt = (n: number): string => n.toLocaleString('en-GB');

export function totalsOf(kind: Kind, rows: readonly InvRow[]): Total[] {
  if (kind === 'cables') {
    let m = 0;
    let none = 0;
    for (const r of rows) {
      const n = r.nums?.length;
      if (n === undefined) none += 1;
      else m += n;
    }
    return [{ label: 'Cable length', value: `${fmt(Math.round(m * 100) / 100)} m` }, ...(none > 0 ? [{ label: 'No length', value: fmt(none) }] : [])];
  }
  if (kind === 'racks') {
    let free = 0;
    let height = 0;
    let devices = 0;
    for (const r of rows) {
      free += r.nums?.free ?? 0;
      height += r.nums?.height ?? 0;
      devices += r.nums?.devices ?? 0;
    }
    return [
      { label: 'Free', value: `${fmt(free)}U of ${fmt(height)}U` },
      { label: 'Devices', value: fmt(devices) },
    ];
  }
  if (kind === 'ports') {
    const cabled = rows.filter((r) => r.facets?.connected?.[0] === 'yes').length;
    return [
      { label: 'Cabled', value: fmt(cabled) },
      { label: 'Free', value: fmt(rows.length - cabled) },
    ];
  }
  return [];
}
