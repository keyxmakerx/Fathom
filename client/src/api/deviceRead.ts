// Device reading's switches (ADR-0082 §4.4): `GET` and `POST /organisations/{o}/device-read`,
// `design_api.rs`'s `device_read_handler` and `device_read_set_handler`, `device_read.rs`.
//
// `server` is whether this server's operator allows reading at all (FATHOM_DEVICE_READ=on),
// `reader` whether its reader answered just now, `on` whether a Steward turned it on here, and
// `usable` all of those plus at least one range. A read goes only to a management address inside a
// listed range; the server refuses loopback, link-local, multicast, reserved, and ranges wider
// than a /8 or a /32, and says why.

import { arrayOf, asRec, jsonObject, optStr, str } from './json';
import { signedFetch } from './signedFetch';

const WHAT = 'device reading';

export interface ReadRange {
  cidr: string;
  snmpPort: number;
  sshPort: number;
  /** A read-only SNMP login (a vault entry id) a Steward set for the whole range, or null. */
  login?: string | null;
}

export interface DeviceReading {
  server: boolean;
  reader: boolean;
  on: boolean;
  usable: boolean;
  ranges: ReadRange[];
  setBy: string | null;
  setAt: number | null;
}

function port(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535 ? v : fallback;
}

export function parseDeviceReading(bytes: Uint8Array): DeviceReading {
  const r = jsonObject(bytes, WHAT);
  return {
    server: r.server === true,
    reader: r.reader === true,
    on: r.on === true,
    usable: r.usable === true,
    ranges: arrayOf(r, 'ranges', WHAT).map((item) => {
      const x = asRec(item, WHAT);
      return { cidr: str(x, 'cidr', WHAT), snmpPort: port(x.snmpPort, 161), sshPort: port(x.sshPort, 22), login: optStr(x, 'login', WHAT) };
    }),
    setBy: optStr(r, 'setBy', WHAT),
    setAt: typeof r.setAt === 'number' ? r.setAt : null,
  };
}

export async function fetchDeviceReading(organisation: string): Promise<DeviceReading> {
  return parseDeviceReading(await signedFetch('GET', `/organisations/${encodeURIComponent(organisation)}/device-read`));
}

/** The body a Steward sends: the switch and the whole list. Ports equal to the defaults are left out. */
export function setBody(on: boolean, ranges: readonly ReadRange[]): string {
  const list = ranges.map((r) => {
    const parts = [`"cidr":${JSON.stringify(r.cidr.trim())}`];
    if (r.login) parts.push(`"login":${JSON.stringify(r.login)}`);
    if (r.snmpPort !== 161) parts.push(`"snmpPort":${r.snmpPort}`);
    if (r.sshPort !== 22) parts.push(`"sshPort":${r.sshPort}`);
    return `{${parts.join(',')}}`;
  });
  return `{"on":${on},"ranges":[${list.join(',')}]}\n`;
}

/** A Steward turns reading on or off here and sets the ranges; answers whether anything changed. */
export async function saveDeviceReading(organisation: string, on: boolean, ranges: readonly ReadRange[]): Promise<boolean> {
  const bytes = await signedFetch(
    'POST',
    `/organisations/${encodeURIComponent(organisation)}/device-read`,
    new TextEncoder().encode(setBody(on, ranges)),
  );
  const answer = JSON.parse(new TextDecoder().decode(bytes)) as { changed?: unknown };
  return answer.changed === true;
}

/**
 * A first look at what a Steward typed, so a plain typo is caught before it is sent. The server
 * checks again and has the last word (loopback, link-local and the rest are its refusals).
 */
export function rangeProblem(cidr: string): string | null {
  const t = cidr.trim();
  const slash = t.indexOf('/');
  if (t === '') return 'Type a range, such as 10.20.0.0/24.';
  if (slash < 0) return 'Add a prefix length, such as /24.';
  const prefix = t.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefix)) return 'The prefix length is a number, such as /24.';
  const n = Number(prefix);
  const v6 = t.slice(0, slash).includes(':');
  if (v6 ? n < 32 || n > 128 : n < 8 || n > 32) return v6 ? 'An IPv6 range is /32 to /128.' : 'An IPv4 range is /8 to /32.';
  return null;
}

// ---- Reading one device (ADR-0082 §4, PR 3): `device_read_routes.rs`. ----

const READ = 'device reading answer';

/** What one read is for: the device itself, or its MAC and ARP tables (read only on request, r91). */
export type ReadKind = 'device' | 'macarp';

/** What a read answered. `confirm`: the agent answered and a person must confirm it before any login is sent. */
export type ReadAnswer =
  | { outcome: 'read'; id: string }
  | { outcome: 'confirm'; engineId: string; state: 'seen' | 'changed'; previous: string | null }
  | { outcome: 'failed'; code: string; message: string; engineId: string | null; previous: string | null };

export function parseReadAnswer(bytes: Uint8Array): ReadAnswer {
  const r = jsonObject(bytes, READ);
  const outcome = str(r, 'outcome', READ);
  if (outcome === 'read') return { outcome, id: str(r, 'id', READ) };
  if (outcome === 'confirm') {
    const state = str(r, 'state', READ);
    return { outcome, engineId: str(r, 'engineId', READ), state: state === 'changed' ? 'changed' : 'seen', previous: optStr(r, 'previous', READ) };
  }
  const f = r.failure != null && typeof r.failure === 'object' ? asRec(r.failure, READ) : {};
  return {
    outcome: 'failed',
    code: typeof f.code === 'string' ? f.code : 'failed',
    message: typeof f.message === 'string' ? f.message : 'The device was not read.',
    engineId: optStr(r, 'engineId', READ),
    previous: optStr(r, 'previous', READ),
  };
}

function readPath(organisation: string, design: string): string {
  return `/organisations/${encodeURIComponent(organisation)}/designs/${encodeURIComponent(design)}/device-read`;
}

/** Canonical JSON (sorted keys, one newline), the shape every signed body takes. */
function canonicalBody(value: Record<string, unknown>): Uint8Array {
  const keys = Object.keys(value).filter((k) => value[k] !== undefined && value[k] !== null).sort();
  return new TextEncoder().encode(`{${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(value[k])}`).join(',')}}\n`);
}

/**
 * Reads one device. With no `login` and an agent not yet confirmed, the server only asks the device
 * who it is and answers `confirm`; `confirm` is the last 8 characters a person typed.
 */
export async function readDevice(
  organisation: string,
  design: string,
  req: { element: string; kind: ReadKind; login?: string | null; confirm?: string | null },
): Promise<ReadAnswer> {
  const body = canonicalBody({ element: req.element, kind: req.kind, login: req.login ?? undefined, confirm: req.confirm ?? undefined });
  return parseReadAnswer(await signedFetch('POST', readPath(organisation, design), body));
}

/** One kept reading. `reading` is only on the latest of each kind; older ones are summary lines. */
export interface KeptReading {
  id: string;
  readBy: string;
  readByName: string | null;
  readAt: number;
  durationMs: number | null;
  incomplete: string[];
  failed: string[];
  macLeftOut: number | null;
  withheld: number | null;
  reading: Record<string, unknown> | null;
}

export interface ReadingPanel {
  readings: KeptReading[];
  macArp: KeptReading | null;
  macArpChanges: { mac: { new: number; gone: number }; arp: { new: number; gone: number } } | null;
  dismissed: { field: string; value: string }[];
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function kept(item: unknown): KeptReading {
  const x = asRec(item, READ);
  const reading = x.reading != null && typeof x.reading === 'object' && !Array.isArray(x.reading) ? (x.reading as Record<string, unknown>) : null;
  return {
    id: str(x, 'id', READ),
    readBy: str(x, 'readBy', READ),
    readByName: optStr(x, 'readByName', READ),
    readAt: num(x.readAt) ?? 0,
    durationMs: num(x.durationMs),
    incomplete: strings(x.incomplete),
    // `failed` is keyed by purpose: what could not be read this time, the rest still kept.
    failed: x.failed != null && typeof x.failed === 'object' && !Array.isArray(x.failed) ? Object.keys(x.failed) : [],
    macLeftOut: num(x.macLeftOut),
    withheld: num(x.withheld),
    reading,
  };
}

function counts(v: unknown): { new: number; gone: number } {
  const r = v != null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  return { new: num(r.new) ?? 0, gone: num(r.gone) ?? 0 };
}

export function parseReadingPanel(bytes: Uint8Array): ReadingPanel {
  const r = jsonObject(bytes, READ);
  const macArp = arrayOf(r, 'macArp', READ).map(kept);
  const ch = r.macArpChanges != null && typeof r.macArpChanges === 'object' ? (r.macArpChanges as Record<string, unknown>) : null;
  return {
    readings: arrayOf(r, 'readings', READ).map(kept),
    macArp: macArp[0] ?? null,
    macArpChanges: ch ? { mac: counts(ch.mac), arp: counts(ch.arp) } : null,
    dismissed: arrayOf(r, 'dismissed', READ).map((item) => {
      const x = asRec(item, READ);
      return { field: str(x, 'field', READ), value: str(x, 'value', READ) };
    }),
  };
}

/** What has been read on one device, newest first, and the differences people dismissed. */
export async function fetchReadingPanel(organisation: string, design: string, element: string): Promise<ReadingPanel> {
  return parseReadingPanel(await signedFetch('GET', `${readPath(organisation, design)}/${encodeURIComponent(element)}`));
}

/** Dismisses one difference until the device says something else (sign-off r100, "until it changes"). */
export async function dismissDifference(organisation: string, design: string, element: string, field: string, value: string): Promise<void> {
  await signedFetch('POST', `${readPath(organisation, design)}/dismiss`, canonicalBody({ element, field, value }));
}

/** An agent (an SNMP engine) a device answered with, by address. */
export interface ReadEngine {
  address: string;
  design: string;
  element: string;
  engineId: string;
  previous: string | null;
  state: 'seen' | 'approved' | 'changed';
  seenAt: number;
  approvedBy: string | null;
}

export function parseEngines(bytes: Uint8Array): ReadEngine[] {
  const r = jsonObject(bytes, READ);
  return arrayOf(r, 'engines', READ).map((item) => {
    const x = asRec(item, READ);
    const state = str(x, 'state', READ);
    return {
      address: str(x, 'address', READ),
      design: str(x, 'design', READ),
      element: str(x, 'element', READ),
      engineId: str(x, 'engineId', READ),
      previous: optStr(x, 'previous', READ),
      state: state === 'approved' || state === 'changed' ? state : 'seen',
      seenAt: num(x.seenAt) ?? 0,
      approvedBy: optStr(x, 'approvedBy', READ),
    };
  });
}

/** Agents waiting for a Steward (Steward only). */
export async function fetchEngines(organisation: string): Promise<ReadEngine[]> {
  return parseEngines(await signedFetch('GET', `/organisations/${encodeURIComponent(organisation)}/device-read/engines`));
}

/** Approves agents by address, as one batch with one log entry (r90). A changed one goes alone. */
export async function approveEngines(organisation: string, addresses: readonly string[]): Promise<number> {
  const bytes = await signedFetch(
    'POST',
    `/organisations/${encodeURIComponent(organisation)}/device-read/engines/approve`,
    canonicalBody({ addresses: [...addresses] }),
  );
  return num((JSON.parse(new TextDecoder().decode(bytes)) as { approved?: unknown }).approved) ?? 0;
}

/** The last 8 characters of an engine id, which a person types to confirm it. */
export function lastEight(engineId: string): string {
  return engineId.slice(-8).toUpperCase();
}

/** An engine id in pairs, the way a device prints it: "80 00 00 09 …". */
export function enginePairs(engineId: string): string[] {
  return (engineId.toUpperCase().match(/.{1,2}/g) ?? []);
}
