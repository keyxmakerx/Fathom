import { describe, expect, it } from 'vitest';

import type { Scope } from '../../api/scopes';
import { newDesignTarget } from './newDesign';

function scope(scopeId: string, parentScopeId: string | null, capability: string): Scope {
  return { scopeId, parentScopeId, kind: parentScopeId === null ? 'network' : 'building', displayName: scopeId, depth: 1, path: scopeId, capability };
}

describe('newDesignTarget', () => {
  it('uses the first Site the person may draw in', () => {
    const scopes = [scope('closet', 'hq', 'draw'), scope('hq', null, 'read'), scope('branch', null, 'draw')];
    expect(newDesignTarget(scopes)).toEqual({ kind: 'scope', scope: scopes[2] });
  });

  it('falls back to a Building or Closet the person may draw in', () => {
    const scopes = [scope('hq', null, 'read'), scope('closet', 'hq', 'draw')];
    expect(newDesignTarget(scopes)).toEqual({ kind: 'scope', scope: scopes[1] });
  });

  it('asks for a new Site when there is nowhere to draw', () => {
    expect(newDesignTarget([])).toEqual({ kind: 'new-site' });
    expect(newDesignTarget([scope('hq', null, 'read')])).toEqual({ kind: 'new-site' });
  });
});
