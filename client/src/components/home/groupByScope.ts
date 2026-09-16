// `docs/OPEN-QUESTIONS.md` D11: a design has no name, so what Home shows
// for it is the scope it hangs under — the closet's `display_name`, not an
// invented one. `designs.ts`'s own doc is explicit that a design whose
// scope the caller cannot read is simply absent from `/scopes`'s answer
// (`scopes.ts`'s own doc, and this route's fixed contract): such a design
// still came back from `/designs` — the account may open it — but nothing
// here can put a name to its closet. This function keeps that fact honest
// rather than papering over it, by keeping those designs apart under
// `elsewhere` instead of guessing.

import type { DesignSummary } from '../../api/designs';
import type { Scope } from '../../api/scopes';

export interface ScopeGroup {
  scope: Scope;
  designs: DesignSummary[];
}

export interface GroupedDesigns {
  /** One entry per scope that has at least one design, sorted by the
   * scope's own `path` — the same ordering `/scopes` itself uses. */
  groups: ScopeGroup[];
  /** Designs whose `scopeId` names a scope that did not come back from
   * `/scopes` — present because the caller may open the design, absent
   * from the tree because the caller may not read its scope. */
  elsewhere: DesignSummary[];
}

/**
 * Pure: sorts designs already in `designs` (whatever order the caller
 * passed, e.g. `sortDesignsByRecency`'s) into the scope each names, without
 * reordering within a group. Never invents a scope: a `scopeId` absent from
 * `scopes` always lands in `elsewhere`, never under a placeholder name.
 */
export function groupDesignsByScope(
  designs: readonly DesignSummary[],
  scopes: readonly Scope[],
): GroupedDesigns {
  const scopeById = new Map(scopes.map((scope) => [scope.scopeId, scope]));
  const designsByScopeId = new Map<string, DesignSummary[]>();
  const elsewhere: DesignSummary[] = [];

  for (const design of designs) {
    if (!scopeById.has(design.scopeId)) {
      elsewhere.push(design);
      continue;
    }
    const bucket = designsByScopeId.get(design.scopeId) ?? [];
    bucket.push(design);
    designsByScopeId.set(design.scopeId, bucket);
  }

  const groups: ScopeGroup[] = Array.from(designsByScopeId.entries())
    .map(([scopeId, scopeDesigns]) => ({ scope: scopeById.get(scopeId)!, designs: scopeDesigns }))
    .sort((a, b) => a.scope.path.localeCompare(b.scope.path));

  return { groups, elsewhere };
}
