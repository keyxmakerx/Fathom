// Admin › Activity: `crates/fathom-server/src/admin.rs`'s `GET /admin/activity`
// and `GET /admin/activity/before/{seq}`, operators only (sign-offs r52,
// 2026-10-27). Every sign-in, refused sign-in and act on the operator console,
// newest first, read out of the sealed site history with the address each came
// from. The server sends chosen fields, never the whole entry.

import { readLp } from '../crypto/bytes';
import { signedFetch } from './signedFetch';

export interface ActivityEntry {
  seq: number;
  /** Unix seconds. */
  at: number;
  entryType: string;
  /** The entry's seal, its link and its metadata binding verified. When false
   * every field below is empty: the page shows that it did not verify, not
   * what it says. */
  verified: boolean;
  account: string;
  name: string;
  /** The client's address: the trusted proxy's forwarding header, or the
   * peer. Empty on entries written before the address was recorded. */
  client: string;
  /** The address the connection came from: the proxy, behind one. */
  via: string;
  reason: string;
}

/** One `LP(line)` per entry; a line is nine tab-separated fields. */
export function parseActivity(bytes: Uint8Array): ActivityEntry[] {
  const decoder = new TextDecoder();
  const out: ActivityEntry[] = [];
  let rest = bytes;
  while (rest.length > 0) {
    const read = readLp(rest);
    rest = read.rest;
    const f = decoder.decode(read.value).split('\t');
    if (f.length !== 9) throw new Error(`malformed activity line: ${f.length} field(s)`);
    out.push({
      seq: Number(f[0]),
      at: Number(f[1]),
      entryType: f[2],
      verified: f[3] === '1',
      account: f[4],
      name: f[5],
      client: f[6],
      via: f[7],
      reason: f[8],
    });
  }
  return out;
}

export async function fetchActivity(before?: number): Promise<ActivityEntry[]> {
  const path = before === undefined ? '/admin/activity' : `/admin/activity/before/${before}`;
  return parseActivity(await signedFetch('GET', path));
}
