// `GET /organisations/{organisation}/scopes`. This route is being added by
// another builder in parallel with this slice, so it cannot be exercised
// against a live server here — its contract is fixed ahead of that landing
// (per the brief that commissioned this file): a JSON array, ordered by
// `path`, of every scope the caller may at least read. Each element:
// `{"scope_id": string, "parent_scope_id": string | null, "kind": string,
// "display_name": string, "depth": number, "path": string, "capability":
// string}`.
//
// **An ancestor the caller may not read is absent even when its descendant
// is present.** A tree built from `parent_scope_id` may therefore have
// several roots, and a scope's displayed path is drawn only from the
// highest ancestor that actually came back — never an invented one. See
// `docs/OPEN-QUESTIONS.md` D11 and
// `docs/decisions/adr-0047-the-shell-four-kinds-of-thing.md` §2.
//
// `createScope` below is `POST /organisations/{organisation}/scopes`, added
// alongside this route by the same parallel build — ADR-0054 §3: "a steward
// of the parent creates a scope," by a route taking `{parent, label}` in the
// body and answering one scope, the same object shape this file's own list
// reads. `parseScope` is split out of `parseScopes` so both read it.

import { concatBytes, lp, utf8 } from '../crypto/bytes';
import { signedFetch } from './signedFetch';

export interface Scope {
  scopeId: string;
  parentScopeId: string | null;
  kind: string;
  displayName: string;
  depth: number;
  path: string;
  capability: string;
}

const REQUIRED_STRING_FIELDS = ['scope_id', 'kind', 'display_name', 'path', 'capability'] as const;

/**
 * Decode and validate one scope object — the shape one element of
 * `/organisations/{organisation}/scopes`'s array holds, and (ADR-0054 §3)
 * the whole body `createScope`'s route answers with. `label` names which
 * body this came from in a thrown message without this function needing to
 * know which caller it is.
 */
export function parseScope(entry: unknown, label: string): Scope {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`malformed scopes response: ${label} is not an object`);
  }
  const record = entry as Record<string, unknown>;
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof record[field] !== 'string' || (record[field] as string).length === 0) {
      throw new Error(`malformed scopes response: ${label} has no ${field}`);
    }
  }
  if (record.parent_scope_id !== null && typeof record.parent_scope_id !== 'string') {
    throw new Error(`malformed scopes response: ${label} has no parent_scope_id`);
  }
  if (typeof record.depth !== 'number') {
    throw new Error(`malformed scopes response: ${label} has no depth`);
  }
  return {
    scopeId: record.scope_id as string,
    parentScopeId: record.parent_scope_id as string | null,
    kind: record.kind as string,
    displayName: record.display_name as string,
    depth: record.depth,
    path: record.path as string,
    capability: record.capability as string,
  };
}

/**
 * Decode and validate one `/organisations/{organisation}/scopes` response
 * body. Throws a plain `Error` — not `ApiRefusal`, which `errors.ts`
 * reserves for a refusal the server itself sent — when the body is not the
 * shape the fixed contract promises: not JSON, not an array, or an element
 * missing a required field or holding the wrong type for it. Mirrors
 * `designs.ts`'s `parseDesigns` and `organisations.ts`'s
 * `parseOrganisations`.
 */
export function parseScopes(bytes: Uint8Array): Scope[] {
  const text = new TextDecoder().decode(bytes);
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : [];
  } catch {
    throw new Error('malformed scopes response: body is not JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('malformed scopes response: body is not a JSON array');
  }
  return parsed.map((entry, index) => parseScope(entry, `entry ${index}`));
}

/**
 * `POST /organisations/{organisation}/scopes` — ADR-0054 §3: "a steward of
 * the parent creates a scope," by a route that takes the parent and a
 * label. Answers with one scope, the same object shape `parseScopes` reads
 * out of the list.
 *
 * `parent: null` names the one case ADR-0054 §3 does not spell out in
 * terms this file can check on its own: an organisation with no scope yet
 * has nothing an account could already be "a steward of a scope" in, so
 * `Home` offers this only as "of the organisation" instead (Home's own
 * brief) — this function sends `null` through unchanged and lets the server
 * decide, and hold, who that is; it does not gate on it, and neither does
 * the caller: a refusal here is a refusal to render, through the same
 * `describeError` path every other action on this screen already uses.
 *
 * `create_scope_handler`'s own wire shape, not JSON: two length-prefixed
 * fields, `crypto::read_lp` twice over (`design_api.rs`'s doc on the
 * handler) — the parent scope id, empty for a new root network, then the
 * label. `bytes.ts`'s `lp`/`concatBytes`/`utf8` are the same helpers
 * `auth.ts` and `enrolment.ts` already use for this server's other
 * length-prefixed routes.
 */
export async function createScope(organisationId: string, parent: string | null, label: string): Promise<Scope> {
  const path = `/organisations/${encodeURIComponent(organisationId)}/scopes`;
  const body = concatBytes(lp(utf8(parent ?? '')), lp(utf8(label)));
  const response = await signedFetch('POST', path, body);
  const text = new TextDecoder().decode(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('malformed create-scope response: body is not JSON');
  }
  return parseScope(parsed, 'the create response');
}

/** Every scope the signed-in account may at least read within
 * `organisationId`, ordered by `path` (the server's own ordering; the
 * caller should not need to re-sort for display, but the helpers below
 * sort explicitly rather than trust it). */
export async function fetchScopes(organisationId: string): Promise<Scope[]> {
  const path = `/organisations/${encodeURIComponent(organisationId)}/scopes`;
  const bytes = await signedFetch('GET', path);
  return parseScopes(bytes);
}

export interface ScopeTreeNode {
  scope: Scope;
  children: ScopeTreeNode[];
}

/**
 * Arrange `scopes` into a forest: children nest under their
 * `parentScopeId`, sorted by `path` at every level. A scope is a root of
 * the forest either because it truly has no parent (`parentScopeId` is
 * `null`) or because its parent was never sent — an ancestor the caller
 * may not read, per this route's own contract — so **several roots is the
 * normal case**, not an error. Pure and total: never throws, never invents
 * a scope that was not in `scopes`.
 */
export function buildScopeForest(scopes: readonly Scope[]): ScopeTreeNode[] {
  const byId = new Map(scopes.map((scope) => [scope.scopeId, scope]));
  const childrenOf = new Map<string, Scope[]>();
  const roots: Scope[] = [];

  for (const scope of scopes) {
    if (scope.parentScopeId !== null && byId.has(scope.parentScopeId)) {
      const siblings = childrenOf.get(scope.parentScopeId) ?? [];
      siblings.push(scope);
      childrenOf.set(scope.parentScopeId, siblings);
    } else {
      roots.push(scope);
    }
  }

  function toNode(scope: Scope): ScopeTreeNode {
    const children = (childrenOf.get(scope.scopeId) ?? [])
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(toNode);
    return { scope, children };
  }

  return roots
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(toNode);
}

/**
 * The chain of scopes leading to `scopeId`, root-most first, ending in
 * `scopeId` itself — drawn from `parentScopeId` links within `scopes`, per
 * this route's own rule: it climbs only as far as an ancestor was actually
 * sent, and stops rather than inventing one that was not. `[]` when
 * `scopeId` itself is not present in `scopes` — there is nothing to draw a
 * path to.
 */
export function pathTo(scopes: readonly Scope[], scopeId: string): Scope[] {
  const byId = new Map(scopes.map((scope) => [scope.scopeId, scope]));
  const target = byId.get(scopeId);
  if (!target) {
    return [];
  }
  const chain: Scope[] = [target];
  let current = target;
  while (current.parentScopeId !== null) {
    const parent = byId.get(current.parentScopeId);
    if (!parent) {
      break;
    }
    chain.unshift(parent);
    current = parent;
  }
  return chain;
}
