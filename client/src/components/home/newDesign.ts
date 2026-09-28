import type { Scope } from '../../api/scopes';
import { canDrawFor } from '../design/useDesignSession';

export type NewDesignTarget = { kind: 'scope'; scope: Scope } | { kind: 'new-site' };

/**
 * Where the home screen's own "New design" puts a design (ADR-0060 decision 6):
 * the first Site the person may draw in, else the first Building or Closet they
 * may draw in, else a new Site made for it. Nobody has to make a Site first.
 */
export function newDesignTarget(scopes: readonly Scope[]): NewDesignTarget {
  const drawable = scopes.filter((scope) => canDrawFor(scope.capability));
  const scope = drawable.find((s) => s.parentScopeId === null) ?? drawable[0];
  return scope ? { kind: 'scope', scope } : { kind: 'new-site' };
}
