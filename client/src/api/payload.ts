// A design's payload — open and save, `crates/fathom-server/src/design_api.rs`'s
// `open_design_handler` and `save_design_handler`. The bytes exchanged here
// are `document/plain.ts`'s plain face (ADR-0049); this module only frames
// them for the wire and never looks inside them.

import { SCHEMA_VERSION } from '../document/plain';
import { signedFetchWithHeaders } from './signedFetch';

/**
 * The four-byte prefix `save_design_handler` reads is the schema version's
 * MINOR number, `u32` little-endian — decided server-side, not this
 * module's choice. `SCHEMA_VERSION` is always `"0.<minor>"` (`fathom-ir`'s
 * generated constant, ADR-0037 on: 0.1 through today's 0.5, each one a
 * schema addition, never a rewrite of the major line), so the number is
 * parsed off it rather than typed a second time — the server now refuses a
 * save whose prefix disagrees with the document's own `schema` line, and a
 * literal here is exactly the kind of second spelling that check exists to
 * catch.
 */
function schemaVersionMinor(): number {
  const prefix = '0.';
  if (!SCHEMA_VERSION.startsWith(prefix)) {
    throw new Error(`SCHEMA_VERSION "${SCHEMA_VERSION}" is not of the form "0.<minor>"`);
  }
  const minor = Number.parseInt(SCHEMA_VERSION.slice(prefix.length), 10);
  if (!Number.isInteger(minor) || minor < 0 || String(minor) !== SCHEMA_VERSION.slice(prefix.length)) {
    throw new Error(`SCHEMA_VERSION "${SCHEMA_VERSION}" has a non-numeric minor part`);
  }
  return minor;
}

export interface OpenedDesign {
  bytes: Uint8Array;
  /** `fathom-design-version` — the chain version this payload was read at. */
  version: number;
  /** `fathom-payload-schema-version` — the four-byte prefix `save_design_handler`
   * itself will read back on the next save. */
  schemaVersion: number;
}

function requiredHeaderInt(headers: Headers, name: string): number {
  const raw = headers.get(name);
  if (raw === null) {
    throw new Error(`open design response: missing "${name}" header`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`open design response: "${name}" is not a decimal integer`);
  }
  return value;
}

/**
 * `GET /organisations/{organisation}/designs/{design}[?version=N]` — the
 * payload at its latest version, or a named one. `open_design_handler` sets
 * `Content-Type: application/octet-stream` and returns the bytes verbatim;
 * the version and schema version travel only in headers, which is why this
 * uses `signedFetchWithHeaders` rather than `signedFetch`.
 */
export async function openDesign(
  organisationId: string,
  designId: string,
  version?: number,
): Promise<OpenedDesign> {
  const query = version === undefined ? '' : `?version=${encodeURIComponent(String(version))}`;
  const path = `/organisations/${encodeURIComponent(organisationId)}/designs/${encodeURIComponent(designId)}${query}`;
  const { bytes, headers } = await signedFetchWithHeaders('GET', path);
  return {
    bytes,
    version: requiredHeaderInt(headers, 'fathom-design-version'),
    schemaVersion: requiredHeaderInt(headers, 'fathom-payload-schema-version'),
  };
}

/**
 * `POST /organisations/{organisation}/designs/{design}/versions` — a new
 * version. Body: `u32_le(schema minor) ‖ bytes`, `save_design_handler`'s
 * exact framing (`read_u32_le`); the response is the new version number as
 * decimal text followed by a newline (`{version}\n`). The prefix is always
 * `schemaVersionMinor()` — derived from the same `SCHEMA_VERSION` `plain.ts`
 * wrote into `bytes`' own `schema` line, never a caller-supplied number that
 * could disagree with it.
 */
export async function saveDesign(
  organisationId: string,
  designId: string,
  bytes: Uint8Array,
): Promise<number> {
  const path = `/organisations/${encodeURIComponent(organisationId)}/designs/${encodeURIComponent(designId)}/versions`;
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, schemaVersionMinor(), true); // little-endian
  const body = new Uint8Array(prefix.length + bytes.length);
  body.set(prefix, 0);
  body.set(bytes, prefix.length);

  const response = await signedFetchWithHeaders('POST', path, body);
  const text = new TextDecoder().decode(response.bytes).trim();
  const version = Number.parseInt(text, 10);
  if (!Number.isFinite(version)) {
    throw new Error(`save design response: "${text}" is not a decimal version number`);
  }
  return version;
}
