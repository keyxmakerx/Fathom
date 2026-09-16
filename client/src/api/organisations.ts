// `GET /organisations`. This route is being added by another builder in
// parallel with this slice, so it cannot be exercised against a live server
// here — its contract is fixed ahead of that landing (per the brief that
// commissioned this file): a JSON array, each element
// `{"organisation_id": string, "display_name": string}`, ordered by id,
// `[]` when the account belongs to nothing. `design_api.rs`'s module doc
// gives the reasoning shared by every structured route in this server —
// canonical JSON, `fathom_canon::Json` — so this parser reads plain
// `JSON.parse` output against that same field-name convention.

import { signedFetch } from './signedFetch';

export interface Organisation {
  organisationId: string;
  displayName: string;
}

/**
 * Decode and validate one `/organisations` response body.
 *
 * Throws a plain `Error` — not `ApiRefusal`, which `errors.ts` reserves for
 * a refusal the server itself sent — when the body is not the shape the
 * fixed contract promises: not JSON, not an array, or an element missing
 * either field or holding the wrong type for it.
 */
export function parseOrganisations(bytes: Uint8Array): Organisation[] {
  const text = new TextDecoder().decode(bytes);
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : [];
  } catch {
    throw new Error('malformed /organisations response: body is not JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('malformed /organisations response: body is not a JSON array');
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`malformed /organisations response: entry ${index} is not an object`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.organisation_id !== 'string' || record.organisation_id.length === 0) {
      throw new Error(`malformed /organisations response: entry ${index} has no organisation_id`);
    }
    if (typeof record.display_name !== 'string') {
      throw new Error(`malformed /organisations response: entry ${index} has no display_name`);
    }
    return { organisationId: record.organisation_id, displayName: record.display_name };
  });
}

/** The organisations the signed-in account belongs to, in the order the
 * server sent them. */
export async function fetchOrganisations(): Promise<Organisation[]> {
  const bytes = await signedFetch('GET', '/organisations');
  return parseOrganisations(bytes);
}
