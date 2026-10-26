// Breach checks (ADR-0071 part three). Run in a browser that holds the login: the first five hex
// characters of the password's SHA-1 go to the Have I Been Pwned range API with `Add-Padding:
// true`, and the rest of the hash is compared here. The password and the rest of its hash never
// leave this tab. Source, read 2026-10-25: https://haveibeenpwned.com/API/v3 ("GET
// https://api.pwnedpasswords.com/range/{first 5 hash chars}"; padding "ensure[s] all results
// contain a random number of records between 800 and 1,000", padded entries have a count of 0;
// "There is no rate limit on the Pwned Passwords API").
//
// Fathom paces itself anyway (docs/OPERATING.md): at most 4 requests at a time, at least 100 ms
// between starts, one request per prefix per tab, batches of 500 oldest-checked first.

import type { BreachLevel, BreachPolicy, LoginKind, VaultEntry } from '../api/vault';
import { utf8 } from '../crypto/bytes';

export const RANGE_URL = 'https://api.pwnedpasswords.com/range/';
export const CRITICAL_INTERVAL_DAYS = 7;
export const DEFAULT_INTERVAL_DAYS = 7;
export const BATCH = 500;
const CONCURRENT = 4;
const SPACING_MS = 100;
const DAY_MS = 86_400_000;

export type PolicyFrom = 'critical' | 'kind' | 'organisation' | 'off';

/** Mirrors `vault_breach::effective`: critical, then the kind, then the organisation, then off. */
export function effectivePolicy(policy: BreachPolicy, kind: LoginKind, critical: boolean): { level: BreachLevel; from: PolicyFrom } {
  if (critical) return { level: { enabled: true, intervalDays: CRITICAL_INTERVAL_DAYS, action: 'refuse' }, from: 'critical' };
  const k = policy.kinds[kind];
  if (k) return { level: k, from: 'kind' };
  if (policy.organisation) return { level: policy.organisation, from: 'organisation' };
  return { level: { enabled: false, intervalDays: DEFAULT_INTERVAL_DAYS, action: 'warn' }, from: 'off' };
}

/** Whether a login's check is due: on, and never checked at this epoch or checked too long ago. */
export function checkDue(entry: VaultEntry, policy: BreachPolicy, now = Date.now()): boolean {
  const { level } = effectivePolicy(policy, entry.kind, entry.critical);
  if (!level.enabled) return false;
  return entry.breach == null || now - entry.breach.checkedAt >= level.intervalDays * DAY_MS;
}

export async function sha1Hex(password: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', utf8(password) as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** The count for `suffix` in a range response; padded lines carry 0 and count as absent. */
export function countIn(range: string, suffix: string): number {
  for (const line of range.split('\n')) {
    const [s, n] = line.trim().split(':');
    if (s?.toUpperCase() === suffix) return Number(n) || 0;
  }
  return 0;
}

// ---- Pacing ----

let active = 0;
let lastStart = 0;
const waiting: (() => void)[] = [];
const ranges = new Map<string, Promise<string>>();

function pump(): void {
  if (active >= CONCURRENT || waiting.length === 0) return;
  const wait = Math.max(0, lastStart + SPACING_MS - Date.now());
  if (wait > 0) {
    setTimeout(pump, wait);
    return;
  }
  lastStart = Date.now();
  active += 1;
  waiting.shift()?.();
  pump();
}

function paced<T>(work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    waiting.push(() => {
      work()
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    });
    pump();
  });
}

/** The fetch the check uses; replaced in tests and in the drive. */
export let fetchRange = (prefix: string): Promise<string> =>
  fetch(RANGE_URL + prefix, { headers: { 'Add-Padding': 'true' }, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' }).then((r) => {
    if (!r.ok) throw new Error(`The breach list answered ${r.status}.`);
    return r.text();
  });

export function setFetchRange(f: (prefix: string) => Promise<string>): void {
  fetchRange = f;
  ranges.clear();
}

function range(prefix: string): Promise<string> {
  let p = ranges.get(prefix);
  if (!p) {
    p = paced(() => fetchRange(prefix));
    ranges.set(prefix, p);
    p.catch(() => ranges.delete(prefix));
  }
  return p;
}

/** How many times `password` appears in the breach list; 0 when it does not. */
export async function timesBreached(password: string): Promise<number> {
  const hash = await sha1Hex(password);
  return countIn(await range(hash.slice(0, 5)), hash.slice(5));
}
