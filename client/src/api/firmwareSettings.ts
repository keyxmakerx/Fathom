// Firmware's limits on Admin › Firmware and Steward › Firmware (sign-off r71,
// crates/fathom-server/src/firmware_settings.rs). The server's settings file gives the starting
// values; a value saved on the Admin page wins over it, and null goes back to the file's. The admin
// sets each organisation's ceiling and can lock it with a reason; a Steward sets their own total
// (under the ceiling) and the address their devices download from. Every change is sealed.

import { ApiRefusal } from './errors';
import { body as canonicalBody } from './fieldDefinitions';
import { signedFetch } from './signedFetch';

/** The values the server is held to, or the file's, or the admin's saved ones (nulls: not saved). */
export interface ServerValues<N = number, S = string> {
  maxImageBytes: N;
  totalMaxBytes: N;
  organisationMaxBytes: N;
  uploadsPerServer: N;
  uploadsPerOrganisation: N;
  uploadIdleSeconds: N;
  fetchBaseUrl: S;
}

export type SavedValues = ServerValues<number | null, string | null>;

export interface Limits extends ServerValues {
  /** The most this organisation's Stewards may set. */
  organisationCeiling: number;
}

export interface Ceiling {
  ceilingBytes: number | null;
  locked: boolean;
  lockReason: string | null;
  changedAtUnix: number;
  version: number;
}

export interface OwnSettings {
  maxBytes: number | null;
  fetchBaseUrl: string | null;
  setAtUnix: number | null;
}

/** One change, from the sealed history. `before`/`after` are the sealed values. */
export interface SettingsChange {
  seq: number;
  type: 'firmware_server_settings_changed' | 'firmware_ceiling_changed' | 'firmware_org_settings_changed' | string;
  atUnix: number;
  byAdmin: boolean;
  byName: string | null;
  organisation: string | null;
  before: unknown;
  after: unknown;
}

export interface StewardFirmwareSettings {
  limits: Limits;
  file: ServerValues;
  server: SavedValues;
  ceiling: Ceiling | null;
  own: OwnSettings;
  history: SettingsChange[];
}

export interface AdminOrganisationRow extends Ceiling {
  organisation: string;
  own: OwnSettings;
  verifies: boolean;
}

export type AdminFirmwareSettings =
  | { on: false }
  | {
      on: true;
      file: ServerValues;
      saved: SavedValues;
      version: number;
      changedAtUnix: number | null;
      limits: Limits;
      organisations: AdminOrganisationRow[];
      history: SettingsChange[];
    };

const dec = new TextDecoder();
type O = Record<string, unknown>;

function parse(bytes: Uint8Array, what: string): O {
  let v: unknown;
  try {
    v = JSON.parse(dec.decode(bytes));
  } catch {
    throw new Error(`malformed firmware settings: ${what} is not JSON`);
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`malformed firmware settings: ${what} is not an object`);
  return v as O;
}

const o = (v: unknown): O => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as O) : {});
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const optNum = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const optStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function values(v: unknown): ServerValues {
  const x = o(v);
  return {
    maxImageBytes: num(x.max_image_bytes),
    totalMaxBytes: num(x.total_max_bytes),
    organisationMaxBytes: num(x.organisation_max_bytes),
    uploadsPerServer: num(x.uploads_per_server),
    uploadsPerOrganisation: num(x.uploads_per_organisation),
    uploadIdleSeconds: num(x.upload_idle_seconds),
    fetchBaseUrl: optStr(x.fetch_base_url) ?? '',
  };
}

function saved(v: unknown): SavedValues {
  const x = o(v);
  return {
    maxImageBytes: optNum(x.max_image_bytes),
    totalMaxBytes: optNum(x.total_max_bytes),
    organisationMaxBytes: optNum(x.organisation_max_bytes),
    uploadsPerServer: optNum(x.uploads_per_server),
    uploadsPerOrganisation: optNum(x.uploads_per_organisation),
    uploadIdleSeconds: optNum(x.upload_idle_seconds),
    fetchBaseUrl: optStr(x.fetch_base_url),
  };
}

function limits(v: unknown): Limits {
  return { ...values(v), organisationCeiling: num(o(v).organisation_ceiling) };
}

function ceiling(v: unknown): Ceiling {
  const x = o(v);
  return {
    ceilingBytes: optNum(x.ceiling_bytes),
    locked: x.locked === true,
    lockReason: optStr(x.lock_reason),
    changedAtUnix: num(x.changed_at_unix),
    version: num(x.version),
  };
}

function own(v: unknown): OwnSettings {
  const x = o(v);
  return { maxBytes: optNum(x.max_bytes), fetchBaseUrl: optStr(x.fetch_base_url), setAtUnix: optNum(x.set_at_unix) };
}

function history(v: unknown): SettingsChange[] {
  if (!Array.isArray(v)) return [];
  return v.map((e) => {
    const x = o(e);
    return {
      seq: num(x.seq),
      type: optStr(x.type) ?? '',
      atUnix: num(x.at_unix),
      byAdmin: x.by_admin === true || typeof x.operator === 'string',
      byName: optStr(x.by_name),
      organisation: optStr(x.organisation),
      before: x.before ?? null,
      after: x.after ?? null,
    };
  });
}

export function parseStewardSettings(bytes: Uint8Array): StewardFirmwareSettings {
  const x = parse(bytes, 'the Steward page');
  return {
    limits: limits(x.limits),
    file: values(x.file),
    server: saved(x.server),
    ceiling: x.ceiling == null ? null : ceiling(x.ceiling),
    own: own(x.own),
    history: history(x.history),
  };
}

export function parseAdminSettings(bytes: Uint8Array): AdminFirmwareSettings {
  const x = parse(bytes, 'the Admin page');
  if (x.on !== true) return { on: false };
  const server = o(x.server);
  return {
    on: true,
    file: values(x.file),
    saved: saved(server.saved),
    version: num(server.version),
    changedAtUnix: optNum(server.changed_at_unix),
    limits: limits(x.limits),
    organisations: Array.isArray(x.organisations)
      ? x.organisations.map((r) => {
          const y = o(r);
          return { ...ceiling(y), organisation: optStr(y.organisation) ?? '', own: own(y.own), verifies: y.verifies !== false };
        })
      : [],
    history: history(x.history),
  };
}

const stewardPath = (organisationId: string) => `/organisations/${encodeURIComponent(organisationId)}/firmware/settings`;

/** Steward only. A 404 means firmware is off on this server. */
export async function fetchStewardSettings(organisationId: string): Promise<StewardFirmwareSettings | null> {
  try {
    return parseStewardSettings(await signedFetch('GET', stewardPath(organisationId)));
  } catch (e) {
    if (e instanceof ApiRefusal && e.status === 404) return null;
    throw e;
  }
}

export const stewardBody = (maxBytes: number | null, fetchBaseUrl: string | null): Uint8Array =>
  canonicalBody({ fetch_base_url: fetchBaseUrl, max_bytes: maxBytes });

export async function saveStewardSettings(organisationId: string, maxBytes: number | null, fetchBaseUrl: string | null): Promise<StewardFirmwareSettings> {
  return parseStewardSettings(await signedFetch('PUT', stewardPath(organisationId), stewardBody(maxBytes, fetchBaseUrl)));
}

export async function fetchAdminSettings(): Promise<AdminFirmwareSettings> {
  return parseAdminSettings(await signedFetch('GET', '/admin/firmware'));
}

export const adminBody = (v: SavedValues, ifVersion: number): Uint8Array =>
  canonicalBody({
    fetch_base_url: v.fetchBaseUrl,
    if_version: ifVersion,
    max_image_bytes: v.maxImageBytes,
    organisation_max_bytes: v.organisationMaxBytes,
    total_max_bytes: v.totalMaxBytes,
    upload_idle_seconds: v.uploadIdleSeconds,
    uploads_per_organisation: v.uploadsPerOrganisation,
    uploads_per_server: v.uploadsPerServer,
  });

export async function saveAdminSettings(v: SavedValues, ifVersion: number): Promise<void> {
  await signedFetch('POST', '/admin/firmware/settings', adminBody(v, ifVersion));
}

export const ceilingBody = (ceilingBytes: number | null, locked: boolean, lockReason: string, ifVersion: number): Uint8Array =>
  canonicalBody({ ceiling_bytes: ceilingBytes, if_version: ifVersion, lock_reason: lockReason, locked });

export async function setOrganisationCeiling(organisation: string, ceilingBytes: number | null, locked: boolean, lockReason: string, ifVersion: number): Promise<void> {
  await signedFetch('POST', `/admin/firmware/organisations/${encodeURIComponent(organisation)}`, ceilingBody(ceilingBytes, locked, lockReason, ifVersion));
}

/** Sizes are typed and shown in GB (10^9 bytes), as `sizeWords` and vendors' download pages write them. */
export const GB = 1e9;

/** "20 GB", "1.5 GB", "512 MB". */
export function gbWords(bytes: number): string {
  if (bytes >= GB) {
    const v = bytes / GB;
    return `${Number.isInteger(v) ? v : v.toFixed(v >= 10 ? 0 : 1)} GB`;
  }
  return `${Math.round(bytes / 1e6)} MB`;
}

/** What a person typed in a GB box, as bytes; null for an empty box; NaN for anything else. */
export function bytesFromGb(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return Number.NaN;
  return Math.round(Number(t) * GB);
}

/** One change in words, for either page. */
export function changeWords(c: SettingsChange): string {
  const who = c.byAdmin ? 'The server’s admin' : (c.byName ?? 'A Steward');
  const after = o(c.after);
  if (c.type === 'firmware_org_settings_changed') {
    const parts = [
      typeof after.max_bytes === 'number' ? `the total to ${gbWords(after.max_bytes)}` : 'the total back to the ceiling',
      typeof after.fetch_base_url === 'string' ? `the download address to ${after.fetch_base_url}` : 'the download address back to the server’s',
    ];
    return `${who} set ${parts.join(' and ')}`;
  }
  if (c.type === 'firmware_ceiling_changed') {
    const cap = typeof after.ceiling_bytes === 'number' ? `the ceiling to ${gbWords(after.ceiling_bytes)}` : 'the ceiling to the server’s default';
    const lock = after.locked === true ? `, locked: “${optStr(after.lock_reason) ?? ''}”` : ', unlocked';
    return `${who} set ${cap}${lock}`;
  }
  if (c.type === 'firmware_server_settings_changed') return `${who} changed the server’s firmware settings`;
  return c.type;
}
