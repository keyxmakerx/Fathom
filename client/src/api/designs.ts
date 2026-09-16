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
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`malformed designs response: entry ${index} is not an object`);
    }
    const record = entry as Record<string, unknown>;
    for (const field of REQUIRED_STRING_FIELDS) {
      if (typeof record[field] !== 'string' || (record[field] as string).length === 0) {
        throw new Error(`malformed designs response: entry ${index} has no ${field}`);
      }
    }
    if (typeof record.created_at_unix !== 'number') {
      throw new Error(`malformed designs response: entry ${index} has no created_at_unix`);
    }
    if (typeof record.latest_version !== 'number') {
      throw new Error(`malformed designs response: entry ${index} has no latest_version`);
    }
    return {
      designId: record.design_id as string,
      scopeId: record.scope_id as string,
      createdAtUnix: record.created_at_unix,
      createdBy: record.created_by as string,
      capability: record.capability as string,
      latestVersion: record.latest_version,
    };
  });
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
