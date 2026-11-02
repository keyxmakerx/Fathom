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
      return { cidr: str(x, 'cidr', WHAT), snmpPort: port(x.snmpPort, 161), sshPort: port(x.sshPort, 22) };
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
