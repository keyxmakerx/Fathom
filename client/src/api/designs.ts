// `GET /organisations/{organisation}/designs`. Shape read off
// `list_designs_handler` in `crates/fathom-server/src/design_api.rs`, not
// assumed: each element is a JSON object with `design_id`, `scope_id`,
// `created_at_unix`, `created_by`, `capability` and `latest_version`. That
// handler filters every row through `grants::authorise_account` before it
// is ever put in the answer — a design the account holds no capability for
// is left out of the array entirely, never sent as a refused or forbidden
// entry. This client draws no such state either: there is nothing to draw
// for a design the caller was never told exists.
//
// Note what the row does NOT carry: no display name, no closet name, and no
// rack/device counts. `designs` has no name column at all (`repo.rs`'s own
// doc on `DesignId`), and `scope_id` is an opaque ULID with no label this
// route resolves. Any screen wanting a human name for a design or its scope
// has nothing here to read it from yet.
//
// `createDesign` below is `POST /organisations/{organisation}/scopes/{scope}/designs`
// — ADR-0054 §2, "draw creates a design": the route takes the scope in the
// signed path and the client's empty document as the body, through the same
// validation a save uses (`payload.ts`'s `saveDesign` framing: `u32_le(schema
// minor) ‖ bytes` — duplicated here in miniature rather than imported,
// because `payload.ts` is not this file's to change), and answers with the
// same shape `list_designs_handler` gives — one element, not an array —
// which is why `parseDesignSummary` is split out of `parseDesigns` rather
// than kept private: both read the one object shape.

import { SCHEMA_VERSION } from '../document/plain';
import { signedFetch } from './signedFetch';

/** `authority.rs`'s `Capability::as_str`: `"read"`, `"draw"` or
 * `"steward"`. Kept as `string` rather than a union here — a value this
 * client does not recognise should still render, not fail to parse. */
export type DesignCapability = string;

export interface DesignSummary {
  designId: string;
  scopeId: string;
  createdAtUnix: number;
  createdBy: string;
  capability: DesignCapability;
  latestVersion: number;
}

const REQUIRED_STRING_FIELDS = ['design_id', 'scope_id', 'created_by', 'capability'] as const;

/**
 * Decode and validate one design summary object — the shape one element of
 * `/organisations/{organisation}/designs`'s array holds, and (ADR-0054 §2)
 * the whole body `createDesign`'s route answers with. `label` identifies
 * which body this came from in a thrown message (`"entry 0"`, `"the create
 * response"`) without this function needing to know which caller it is.
 */
export function parseDesignSummary(entry: unknown, label: string): DesignSummary {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`malformed designs response: ${label} is not an object`);
  }
  const record = entry as Record<string, unknown>;
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof record[field] !== 'string' || (record[field] as string).length === 0) {
      throw new Error(`malformed designs response: ${label} has no ${field}`);
    }
  }
  if (typeof record.created_at_unix !== 'number') {
    throw new Error(`malformed designs response: ${label} has no created_at_unix`);
  }
  if (typeof record.latest_version !== 'number') {
    throw new Error(`malformed designs response: ${label} has no latest_version`);
  }
  return {
    designId: record.design_id as string,
    scopeId: record.scope_id as string,
    createdAtUnix: record.created_at_unix,
    createdBy: record.created_by as string,
    capability: record.capability as string,
    latestVersion: record.latest_version,
  };
}

/**
 * Decode and validate one `/organisations/{organisation}/designs` response
 * body. Throws a plain `Error` — not `ApiRefusal`, reserved for a refusal
 * the server itself sent (`errors.ts`) — for a body that is not JSON, not
 * an array, or an element missing a required field or holding the wrong
 * type for it.
 */
export function parseDesigns(bytes: Uint8Array): DesignSummary[] {
  const text = new TextDecoder().decode(bytes);
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : [];
  } catch {
    throw new Error('malformed designs response: body is not JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('malformed designs response: body is not a JSON array');
  }
  return parsed.map((entry, index) => parseDesignSummary(entry, `entry ${index}`));
}

/**
 * `save_design_handler`'s own wire prefix (`payload.ts`'s `saveDesign`,
 * verbatim): the schema's minor version as `u32_le`, read off `SCHEMA_VERSION`
 * rather than typed a second time. Kept here rather than imported from
 * `payload.ts` — this file's own brief does not extend to changing that
 * module, and the duplication is four lines against a shared constant, not a
 * second spelling of the version number itself.
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

/**
 * `POST /organisations/{organisation}/scopes/{scope}/designs` — ADR-0054
 * §2: "draw creates a design." `bytes` is the plain-encoded document to
 * create it with — Home always passes `writePlain(emptyDocument())`, never
 * anything read back from a live editor, because a bodiless design is never
 * minted and a fresh design starts from nothing. Framed exactly as
 * `saveDesign` frames a save (`u32_le(schema minor) ‖ bytes`) because the
 * route validates it the same way; answers with one design summary, the
 * same object shape `parseDesigns` reads out of the list.
 */
export async function createDesign(
  organisationId: string,
  scopeId: string,
  bytes: Uint8Array,
): Promise<DesignSummary> {
  const path = `/organisations/${encodeURIComponent(organisationId)}/scopes/${encodeURIComponent(scopeId)}/designs`;
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, schemaVersionMinor(), true); // little-endian
  const body = new Uint8Array(prefix.length + bytes.length);
  body.set(prefix, 0);
  body.set(bytes, prefix.length);

  const response = await signedFetch('POST', path, body);
  const text = new TextDecoder().decode(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('malformed create-design response: body is not JSON');
  }
  return parseDesignSummary(parsed, 'the create response');
}

/** The designs the signed-in account may see within `organisationId` — a
 * design it may not is simply absent, per the handler's own doc. */
export async function fetchDesigns(organisationId: string): Promise<DesignSummary[]> {
  const path = `/organisations/${encodeURIComponent(organisationId)}/designs`;
  const bytes = await signedFetch('GET', path);
  return parseDesigns(bytes);
}

/**
 * Most-recent-first, the ordering a person choosing what to open wants.
 * `list_designs_handler` sends them oldest-first (`ORDER BY d.created_at`,
 * ascending) because that SQL ordering is what keeps its pagination-free
 * query deterministic, not because it is the order to show — sorting is
 * this screen's own decision, so it is a named, tested function rather than
 * an inline `.sort()` at the call site. Stable for equal timestamps: the
 * server's own order is the tiebreak.
 */
export function sortDesignsByRecency(designs: readonly DesignSummary[]): DesignSummary[] {
  return designs
    .map((design, index) => ({ design, index }))
    .sort((a, b) => b.design.createdAtUnix - a.design.createdAtUnix || a.index - b.index)
    .map((entry) => entry.design);
}
