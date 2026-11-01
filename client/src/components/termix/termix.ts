// Termix beside Fathom (ADR-0078). This browser talks to the operator's Termix with the person's
// own Termix API key; Fathom's server never sees the key and never calls Termix.
//
// What Termix offers, read from its source (github.com/Termix-SSH/Termix at 73c15f7, 22 October
// 2026, read 27 October 2026):
// - An API key is `tmx_` and 64 hex characters, made by a Termix admin for one Termix user, sent
//   as `Authorization: Bearer` (`src/backend/utils/auth-manager.ts`, `handleApiKeyAuth`).
// - `GET /host/db/host` lists the hosts that user can see; `POST /host/db/host` adds one, and
//   needs `ip`, `port` and, since v26.10.2, `authType` (`src/backend/database/routes/host.ts`; found
//   by the CI job against a real Termix 26.10.6, ADR-0080 decision 1, 1 November 2026).
// - `/?view=terminal&hostId=<id>` opens one host's terminal full screen, signing in first when
//   the browser is signed out (`src/main.tsx`, `FullscreenApp`; the `terminal` tab is the bundled
//   ssh-terminal plugin's).
// - Termix answers any origin unless its operator sets `CORS_ALLOWED_ORIGINS`
//   (`src/backend/utils/cors-config.ts`); with it set, Fathom's address has to be in the list.
//
// Nothing here sends a password. A host Fathom adds carries a name, an address, port 22, a
// folder and a tag; the person picks a Termix credential in Termix.

/** Where the key waits: this tab only, gone when the tab closes (ADR-0078 decision 3). */
const KEY_SLOT = 'fathom.termix.key';

/** `tmx_` and 64 hex characters, as Termix makes them. */
export function isTermixKey(value: string): boolean {
  return /^tmx_[0-9a-f]{64}$/.test(value.trim());
}

export function readKey(store: Pick<Storage, 'getItem'> | null = safeSession()): string | null {
  try {
    const v = store?.getItem(KEY_SLOT) ?? null;
    return v && isTermixKey(v) ? v : null;
  } catch {
    return null;
  }
}

export function saveKey(key: string, store: Pick<Storage, 'setItem'> | null = safeSession()): void {
  try {
    store?.setItem(KEY_SLOT, key.trim());
  } catch {
    // Without storage the key lasts as long as the component holding it.
  }
}

export function forgetKey(store: Pick<Storage, 'removeItem'> | null = safeSession()): void {
  try {
    store?.removeItem(KEY_SLOT);
  } catch {
    // nothing to forget
  }
}

function safeSession(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** A management address as Termix stores it: no prefix length, no brackets. */
export function bareAddress(address: string): string {
  const a = address.trim().replace(/\/\d{1,3}$/, '');
  return a.startsWith('[') && a.endsWith(']') ? a.slice(1, -1) : a;
}

/**
 * Whether a management address is one Termix can connect to: an IPv4 or IPv6 address or a DNS
 * host name. Anyone who can draw can type any text there, so nothing else is sent to Termix.
 */
export function isHostAddress(address: string): boolean {
  const a = bareAddress(address);
  if (a === '' || a.length > 253) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(a)) return a.split('.').every((p) => Number(p) <= 255);
  if (a.includes(':')) {
    const groups = a.split(':').length;
    return /^[0-9a-f:.]+$/i.test(a) && (a.match(/::/g)?.length ?? 0) <= 1 && groups >= 3 && groups <= 8;
  }
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(a);
}

/** The full-screen terminal for one Termix host. */
export function terminalUrl(origin: string, hostId: number): string {
  const u = new URL('/', origin);
  u.searchParams.set('view', 'terminal');
  u.searchParams.set('hostId', String(hostId));
  return u.toString();
}

export interface TermixHost {
  id: number;
  name: string;
  ip: string;
  port: number;
}

/** Termix's host list, read loosely: only what Fathom matches on, rows without it skipped. */
export function parseHosts(body: unknown): TermixHost[] {
  if (!Array.isArray(body)) throw new TermixError('Termix answered with something that is not a host list.');
  const out: TermixHost[] = [];
  for (const row of body) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const id = Number(r.id);
    if (!Number.isInteger(id) || typeof r.ip !== 'string') continue;
    out.push({ id, name: typeof r.name === 'string' ? r.name : r.ip, ip: r.ip, port: Number(r.port) || 22 });
  }
  return out;
}

/** The host to open for a device: its address on port 22 first, then its address on any port. */
export function matchHost(hosts: TermixHost[], address: string): TermixHost | null {
  const want = bareAddress(address).toLowerCase();
  const same = hosts.filter((h) => h.ip.trim().toLowerCase() === want);
  return same.find((h) => h.port === 22) ?? same[0] ?? null;
}

/**
 * Whether Termix's host is the device by name too (sign-off r61). A host is matched by address
 * alone, and anyone who can draw can give a device another machine's address, so a host whose
 * own name differs is shown and asked about before its terminal opens.
 */
export function sameHostName(host: TermixHost, deviceName: string): boolean {
  const norm = (v: string) => v.trim().toLowerCase();
  return norm(deviceName) !== '' && norm(host.name) === norm(deviceName);
}

/** Termix's folder for a design's hosts: `Fathom / <design>`, Termix's own nesting separator. */
export function folderFor(design: string): string {
  const d = design.replace(/\s*\/\s*/g, ' - ').trim();
  return d ? `Fathom / ${d}` : 'Fathom';
}

/**
 * What Fathom sends to add a host: no credential, no user name. `authType: 'none'` is the one Termix
 * value that carries no secret: Termix then asks at connect time, keyboard-interactive
 * (`src/backend/hosts/connect/build-connect-config.ts`, v26.10.6), and the person can pick one of
 * Termix's own credentials on the host instead. Termix refuses a new host without an `authType`
 * since v26.10.2.
 */
export function newHostBody(name: string, address: string, folder = 'Fathom'): Record<string, unknown> {
  return {
    connectionType: 'ssh',
    authType: 'none',
    name: name.trim() || bareAddress(address),
    ip: bareAddress(address),
    port: 22,
    folder,
    tags: ['fathom'],
    notes: 'Added from Fathom.',
  };
}

export class TermixError extends Error {}

type Fetch = typeof fetch;

async function call(origin: string, key: string, method: string, path: string, body: unknown, f: Fetch): Promise<unknown> {
  let res: Response;
  try {
    res = await f(new URL(path, origin).toString(), {
      method,
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      redirect: 'error',
    });
  } catch {
    throw new TermixError(
      'This browser could not reach Termix. Check that it is running, and if its operator set CORS_ALLOWED_ORIGINS, that Fathom’s address is in it.',
    );
  }
  if (res.status === 401) throw new TermixError('Termix refused the API key. It may have expired or been switched off; paste a new one.');
  if (res.status === 403) throw new TermixError('The Termix user this key belongs to is not allowed to do that.');
  if (!res.ok) throw new TermixError(`Termix answered ${res.status}.`);
  try {
    return await res.json();
  } catch {
    throw new TermixError('Termix answered with something that is not JSON.');
  }
}

export async function listHosts(origin: string, key: string, f: Fetch = fetch): Promise<TermixHost[]> {
  return parseHosts(await call(origin, key, 'GET', '/host/db/host', undefined, f));
}

export async function addHost(origin: string, key: string, name: string, address: string, f: Fetch = fetch, folder?: string): Promise<TermixHost> {
  const [made] = parseHosts([await call(origin, key, 'POST', '/host/db/host', newHostBody(name, address, folder), f)]);
  if (!made) throw new TermixError('Termix added the host but did not say which one it is.');
  return made;
}

export interface SendResult {
  added: number;
  /** Already in Termix at that address. */
  already: number;
  /** Two devices with one address are sent once. */
  repeated: number;
  failed: string[];
}

/**
 * Many devices at once (card r43-termix, "send a whole design"): one list, then one add per
 * device Termix does not have at that address, in the design's folder. One at a time through
 * Termix's core route, because its bulk import belongs to a plugin a Termix may not run. A
 * refused key stops the run; any other refusal is counted and the run goes on.
 */
export async function sendHosts(
  origin: string,
  key: string,
  devices: readonly { name: string; address: string }[],
  folder: string,
  f: Fetch = fetch,
  onStep?: (done: number, total: number) => void,
): Promise<SendResult> {
  const hosts = await listHosts(origin, key, f);
  const out: SendResult = { added: 0, already: 0, repeated: 0, failed: [] };
  const seen = new Set<string>();
  const todo = devices.filter((d) => bareAddress(d.address) !== '');
  let done = 0;
  for (const d of todo) {
    const at = bareAddress(d.address).toLowerCase();
    if (!isHostAddress(at)) out.failed.push(`${d.name || at}: not an IP address or host name`);
    else if (seen.has(at)) out.repeated++;
    else if (matchHost(hosts, at)) out.already++;
    else {
      try {
        await addHost(origin, key, d.name, d.address, f, folder);
        out.added++;
      } catch (e) {
        if (e instanceof TermixError && /API key/.test(e.message)) throw e;
        out.failed.push(`${d.name || at}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    seen.add(at);
    onStep?.(++done, todo.length);
  }
  return out;
}

/** The result in one sentence. */
export function sendSummary(r: SendResult): string {
  const parts = [`Added ${r.added} to Termix`];
  if (r.already) parts.push(`${r.already} ${r.already === 1 ? 'was' : 'were'} already there`);
  if (r.repeated) parts.push(`${r.repeated} shared an address with another device`);
  if (r.failed.length) parts.push(`${r.failed.length} not added (${r.failed.slice(0, 2).join('; ')})`);
  return parts.join('; ') + '.';
}
