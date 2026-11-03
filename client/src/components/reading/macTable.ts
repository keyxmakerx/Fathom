// The MAC and ARP tables of one switch, as rows a person searches (ADR-0082 §4.3; sign-off r100).
// Pure: the kept `macarp` reading in, rows out. MACs on ports facing another switch or router were
// already left out by the server (`device_reading.rs`'s `edge_macs`).

import { interfaceNames } from './differences';

export interface MacRow {
  port: string;
  mac: string;
  /** The filtering database id. On the switches checked it is the VLAN; null when not said. */
  vlan: number | null;
  /** Every address the ARP table gives this MAC, joined. */
  ip: string;
}

type Rec = Record<string, unknown>;

function rows(v: unknown): Rec[] {
  return Array.isArray(v) ? (v.filter((x) => x != null && typeof x === 'object') as Rec[]) : [];
}

/** dot1dTpFdbStatus self, mgmt and invalid are the switch's own or dead entries, not something plugged in. */
const NOT_PLUGGED_IN = new Set(['self', 'mgmt', 'invalid']);

export function macRows(reading: Rec | null): { rows: MacRow[]; arp: number } {
  if (!reading) return { rows: [], arp: 0 };
  const names = interfaceNames(reading);
  const arp = rows(reading.arp).filter((r) => typeof r.mac === 'string' && typeof r.ip === 'string' && r.type !== 'invalid');
  const ipsOf = new Map<string, string[]>();
  for (const r of arp) {
    const key = (r.mac as string).toLowerCase();
    const list = ipsOf.get(key) ?? [];
    if (!list.includes(r.ip as string)) list.push(r.ip as string);
    ipsOf.set(key, list);
  }
  const out: MacRow[] = [];
  for (const r of rows(reading.mac)) {
    if (typeof r.mac !== 'string' || NOT_PLUGGED_IN.has(String(r.status))) continue;
    const ifi = typeof r.ifIndex === 'number' ? names.get(r.ifIndex) : undefined;
    const port = ifi?.name ?? ifi?.descr ?? (typeof r.bridgePort === 'number' ? `bridge port ${r.bridgePort}` : '—');
    const mac = r.mac.toLowerCase();
    out.push({ port, mac, vlan: typeof r.fdbId === 'number' ? r.fdbId : null, ip: (ipsOf.get(mac) ?? []).join(', ') });
  }
  out.sort((a, b) => a.port.localeCompare(b.port, 'en', { numeric: true }) || a.mac.localeCompare(b.mac));
  return { rows: out, arp: arp.length };
}

/** A MAC typed any common way (3C-22-FB, 3c22.fb10, 3c:22:fb) as the hex it holds. */
function hexOnly(s: string): string {
  return s.toLowerCase().replace(/[^0-9a-f]/g, '');
}

/** Rows matching what was typed: part of a MAC in any notation, part of an address, or a port. */
export function matches(row: MacRow, find: string): boolean {
  const t = find.trim().toLowerCase();
  if (t === '') return false;
  const hex = hexOnly(t);
  if (hex.length >= 4 && hexOnly(row.mac).includes(hex)) return true;
  return row.mac.includes(t) || row.ip.toLowerCase().includes(t) || row.port.toLowerCase() === t;
}

/** The table as CSV, for a ticket or a spreadsheet. A field that opens with = + - @ is quoted with a ' so a spreadsheet does not run it. */
export function asCsv(list: readonly MacRow[]): string {
  const cell = (v: string) => {
    const safe = /^[=+\-@]/.test(v) ? `'${v}` : v;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return ['Port,MAC,VLAN,IP', ...list.map((r) => [r.port, r.mac, r.vlan === null ? '' : String(r.vlan), r.ip].map(cell).join(','))].join('\n') + '\n';
}
