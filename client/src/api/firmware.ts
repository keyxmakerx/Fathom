// Firmware staging (ADR-0045, crates/fathom-server/src/firmware.rs). Five routes, and the client
// never connects to a device: it declares an image, sends its bytes, reads back what is staged, and
// asks for a one-time link a switch can fetch from. The bytes never pass through memory here: the
// browser reads the File as it sends it.
//
// When the server runs without firmware (no FATHOM_FIRMWARE_FETCH_BASE_URL) these routes are not
// mounted and a list answers 404 with no body; `listFirmware` turns that into `FirmwareOff`.

import { concatBytes, lp, u64LE, utf8 } from '../crypto/bytes';
import { ApiRefusal } from './errors';
import { body as canonicalBody } from './fieldDefinitions';
import { signedFetch } from './signedFetch';

/** `HEADER_UPLOAD_TOKEN` in firmware.rs; the declaration names it too, and that wins. */
const FALLBACK_TOKEN_HEADER = 'fathom-firmware-upload-token';

export class FirmwareOff extends Error {
  constructor() {
    super('Firmware is off on this server.');
    this.name = 'FirmwareOff';
  }
}

export type ImageState = 'declared' | 'staged' | 'failed' | string;

export interface FirmwareStep {
  order: number;
  step: string;
  command: string;
  note: string;
}

/** What the device can compute, and what to compare it with (firmware_commands.rs). */
export interface DeviceHash {
  /** `sha256` where Fathom's hash is comparable; `sha512` on IOS XE. */
  algorithm: string;
  /** `expected_sha256`, or `vendor_published_sha512`. */
  comparesWith: string;
}

export interface FirmwareCommands {
  expectedSha256: string;
  devicePath: string;
  steps: FirmwareStep[];
  sourcedNote: string;
  /** `none` when no steps are written for the platform. */
  sourced: string;
  platform: string | null;
  /** `junos`, `ios-xe`, `nx-os`, `eos`, or `unknown`. */
  family: string;
  /** What the vendor's pages did not settle; shown, never papered over. */
  couldNotEstablish: string[];
  deviceHash: DeviceHash;
}

export interface FirmwareImage {
  imageId: string;
  filename: string;
  byteLength: number;
  state: ImageState;
  failedReason: string | null;
  createdAtUnix: number;
  stagedAtUnix: number | null;
  /** The hash Fathom computed over the bytes it holds, or null before they arrived. */
  sha256: string | null;
  /** What the person said it is for; absent from a server that does not carry them yet. */
  platform: string | null;
  version: string | null;
  /** The catalogue models it is for; empty from a server that does not carry them yet. */
  models: string[];
  commands: FirmwareCommands | null;
}

export interface FetchLink {
  imageId: string;
  filename: string;
  sha256: string;
  url: string;
  expiresAtUnix: number;
  commands: FirmwareCommands | null;
}

const base = (organisationId: string) => `/organisations/${encodeURIComponent(organisationId)}`;
const scopePath = (organisationId: string, scopeId: string) => `${base(organisationId)}/scopes/${encodeURIComponent(scopeId)}/firmware`;

function json(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`malformed firmware response: ${what} is not JSON`);
  }
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`malformed firmware response: ${what} is not an object`);
  return v as Record<string, unknown>;
}

function strField(o: Record<string, unknown>, key: string, what: string): string {
  const v = o[key];
  if (typeof v !== 'string') throw new Error(`malformed firmware response: ${what} has no ${key}`);
  return v;
}

function numField(o: Record<string, unknown>, key: string, what: string): number {
  const v = o[key];
  if (typeof v !== 'number') throw new Error(`malformed firmware response: ${what} has no ${key}`);
  return v;
}

const optStr = (o: Record<string, unknown>, key: string): string | null => (typeof o[key] === 'string' && o[key] !== '' ? (o[key] as string) : null);
const optNum = (o: Record<string, unknown>, key: string): number | null => (typeof o[key] === 'number' ? (o[key] as number) : null);

function parseCommands(v: unknown): FirmwareCommands | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, 'commands');
  const steps = Array.isArray(o.steps) ? o.steps : [];
  const dh = typeof o.device_hash === 'object' && o.device_hash !== null && !Array.isArray(o.device_hash) ? (o.device_hash as Record<string, unknown>) : {};
  return {
    expectedSha256: typeof o.expected_sha256 === 'string' ? o.expected_sha256 : '',
    devicePath: typeof o.device_path === 'string' ? o.device_path : '',
    sourcedNote: typeof o.sourced_note === 'string' ? o.sourced_note : '',
    sourced: typeof o.sourced === 'string' ? o.sourced : '',
    platform: optStr(o, 'platform'),
    family: typeof o.family === 'string' ? o.family : '',
    couldNotEstablish: Array.isArray(o.could_not_establish) ? o.could_not_establish.filter((m): m is string => typeof m === 'string' && m !== '') : [],
    deviceHash: {
      algorithm: typeof dh.algorithm === 'string' && dh.algorithm !== '' ? dh.algorithm : 'sha256',
      comparesWith: typeof dh.compares_with === 'string' && dh.compares_with !== '' ? dh.compares_with : 'expected_sha256',
    },
    steps: steps.map((s, i) => {
      const r = obj(s, `step ${i}`);
      return { order: optNum(r, 'order') ?? i + 1, step: strField(r, 'step', `step ${i}`), command: strField(r, 'command', `step ${i}`), note: typeof r.note === 'string' ? r.note : '' };
    }),
  };
}

export function parseImage(v: unknown, label = 'an image'): FirmwareImage {
  const o = obj(v, label);
  return {
    imageId: strField(o, 'image_id', label),
    filename: strField(o, 'filename', label),
    byteLength: numField(o, 'byte_length', label),
    state: strField(o, 'state', label),
    failedReason: optStr(o, 'failed_reason'),
    createdAtUnix: optNum(o, 'created_at_unix') ?? 0,
    stagedAtUnix: optNum(o, 'staged_at_unix'),
    sha256: optStr(o, 'sha256'),
    platform: optStr(o, 'platform'),
    version: optStr(o, 'version'),
    models: Array.isArray(o.models) ? o.models.filter((m): m is string => typeof m === 'string' && m !== '') : [],
    commands: parseCommands(o.commands),
  };
}

export function parseImages(bytes: Uint8Array): FirmwareImage[] {
  const parsed = bytes.length === 0 ? [] : json(bytes, 'the list');
  if (!Array.isArray(parsed)) throw new Error('malformed firmware response: the list is not an array');
  return parsed.map((e, i) => parseImage(e, `image ${i}`));
}

/** The images staged for a scope. Throws `FirmwareOff` when the server has firmware turned off. */
export async function listFirmware(organisationId: string, scopeId: string): Promise<FirmwareImage[]> {
  try {
    return parseImages(await signedFetch('GET', scopePath(organisationId, scopeId)));
  } catch (e) {
    // The routes are not mounted: a bare 404. A real "no such scope" says so in its body.
    if (e instanceof ApiRefusal && e.status === 404 && !/scope/i.test(e.message)) throw new FirmwareOff();
    throw e;
  }
}

export interface Declaration {
  filename: string;
  byteLength: number;
  /** 64 lowercase hex: the hash the vendor publishes. */
  sha256: string;
  platform?: string;
  version?: string;
  /** Catalogue models the image is for. */
  models?: readonly string[];
}

/**
 * The signed declaration body: `LP(filename) || LP(u64le length) || LP(sha256)`, and with `withMeta`
 * `|| LP(platform) || LP(version) || LP(models, comma-separated)`; an empty one means "not given".
 */
export function declarationBody(d: Declaration, withMeta: boolean): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(d.sha256)) throw new Error('A SHA-256 is 64 hexadecimal characters.');
  const digest = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) digest[i] = Number.parseInt(d.sha256.slice(i * 2, i * 2 + 2), 16);
  const parts = [lp(utf8(d.filename)), lp(u64LE(d.byteLength)), lp(digest)];
  if (withMeta) parts.push(lp(utf8(d.platform ?? '')), lp(utf8(d.version ?? '')), lp(utf8((d.models ?? []).join(','))));
  return concatBytes(...parts);
}

export interface Declared {
  imageId: string;
  uploadPath: string;
  uploadToken: string;
  tokenHeader: string;
  expiresAtUnix: number;
}

export function parseDeclared(bytes: Uint8Array): Declared {
  const o = obj(json(bytes, 'the declaration'), 'the declaration');
  return {
    imageId: strField(o, 'image_id', 'the declaration'),
    uploadPath: strField(o, 'upload_path', 'the declaration'),
    uploadToken: strField(o, 'upload_token', 'the declaration'),
    tokenHeader: typeof o.upload_token_header === 'string' ? o.upload_token_header : FALLBACK_TOKEN_HEADER,
    expiresAtUnix: optNum(o, 'upload_token_expires_at_unix') ?? 0,
  };
}

/** Tells the server what is coming and the hash it must have. Steward access is needed. */
export async function declareImage(organisationId: string, scopeId: string, d: Declaration): Promise<Declared> {
  const withMeta = (d.platform ?? '') !== '' || (d.version ?? '') !== '' || (d.models ?? []).length > 0;
  return parseDeclared(await signedFetch('POST', scopePath(organisationId, scopeId), declarationBody(d, withMeta)));
}

export const MAX_MODELS = 16;

/** `safe_models` in firmware.rs: at most 16, each 1 to 64 of letters, digits and `- _ . / +`, no duplicates. */
export function modelsProblem(models: readonly string[]): string | null {
  if (models.length > MAX_MODELS) return `An image can name at most ${MAX_MODELS} models.`;
  for (const [i, m] of models.entries()) {
    if (!/^[A-Za-z0-9._/+-]{1,64}$/.test(m)) return `"${m}" is not a model id: 1 to 64 characters of letters, digits and - _ . / + only.`;
    if (models.indexOf(m) !== i) return `"${m}" is listed twice.`;
  }
  return null;
}

export interface ModelsChanged {
  imageId: string;
  models: string[];
  /** False when the list was already this one: nothing was sealed. */
  changed: boolean;
  changedSeq: number | null;
}

/** The exact body of the models call: `{"models":["A","B"]}` and a newline. */
export const modelsBody = (models: readonly string[]): Uint8Array => canonicalBody({ models });

/** Replaces the whole list of models an image is for (`[]` clears it). Steward access is needed. */
export async function setImageModels(organisationId: string, imageId: string, models: readonly string[]): Promise<ModelsChanged> {
  const problem = modelsProblem(models);
  if (problem !== null) throw new Error(problem);
  const bytes = await signedFetch('PUT', `${base(organisationId)}/firmware/${encodeURIComponent(imageId)}/models`, modelsBody(models));
  const o = obj(json(bytes, 'the models answer'), 'the models answer');
  return {
    imageId: strField(o, 'image_id', 'the models answer'),
    models: Array.isArray(o.models) ? o.models.filter((m): m is string => typeof m === 'string') : [],
    changed: o.changed === true,
    changedSeq: optNum(o, 'changed_seq'),
  };
}

/**
 * Sends the bytes. `XMLHttpRequest` and not `fetch`, because only it reports how much of a file has
 * gone; the browser still reads the File as it sends it and never holds the whole of it. Unsigned:
 * the single-use token from the declaration is the authority (ADR-0045 section 4).
 */
export function sendImageBytes(
  declared: Declared,
  file: File,
  onProgress: (sent: number, total: number) => void,
  signal?: AbortSignal,
): Promise<FirmwareImage | null> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', declared.uploadPath);
    xhr.setRequestHeader(declared.tokenHeader, declared.uploadToken);
    xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : file.size);
    xhr.onerror = () => reject(new Error('The upload was cut off before it finished. Nothing was staged; try again.'));
    xhr.onabort = () => reject(new Error('The upload was stopped.'));
    xhr.onload = () => {
      const text = (xhr.responseText ?? '').trim();
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(text === '' ? null : parseImage(JSON.parse(text)));
        } catch {
          resolve(null);
        }
        return;
      }
      reject(new ApiRefusal(xhr.status, text === '' ? 'refused' : text, null));
    };
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/** Issues a one-time link for a staged image. Steward access is needed; the link lasts 15 minutes. */
export async function issueFetchLink(organisationId: string, imageId: string): Promise<FetchLink> {
  const bytes = await signedFetch('POST', `${base(organisationId)}/firmware/${encodeURIComponent(imageId)}/fetch-urls`);
  const o = obj(json(bytes, 'the link'), 'the link');
  return {
    imageId: strField(o, 'image_id', 'the link'),
    filename: strField(o, 'filename', 'the link'),
    sha256: strField(o, 'sha256', 'the link'),
    url: strField(o, 'fetch_url', 'the link'),
    expiresAtUnix: numField(o, 'fetch_url_expires_at_unix', 'the link'),
    commands: parseCommands(o.commands),
  };
}

/** What a refusal means here, in the words a person needs. */
export function firmwareRefusalWords(e: unknown, doing: 'upload' | 'link' | 'list' = 'upload'): string {
  if (e instanceof FirmwareOff) return e.message;
  if (e instanceof ApiRefusal) {
    if (e.status === 403) return doing === 'list' ? 'You do not have access to firmware here.' : 'Only a steward can do this. Ask someone with steward access.';
    if (e.status === 401) return 'Your sign-in ended. Sign in again.';
    if (e.status === 409 || e.status === 413 || e.status === 400) return e.message.replace(/\.?\s*$/, '.');
    if (e.status === 404) return 'The server does not have that image any more.';
    if (e.retryAfterSeconds != null) return `${e.message} Try again in ${e.retryAfterSeconds}s.`;
    return e.message;
  }
  return e instanceof Error ? e.message : 'That did not go through.';
}

/** "1.4 GB" and "812 MB", the way a download page writes a size. */
export function sizeWords(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} bytes`;
}

/** First and last characters of a hash, enough to tell two apart. */
export function shortHash(hex: string | null | undefined): string {
  return hex ? `${hex.slice(0, 4)}…${hex.slice(-4)}` : '';
}
