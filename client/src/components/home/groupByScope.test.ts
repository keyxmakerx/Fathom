import { describe, expect, it } from 'vitest';

import type { DesignSummary } from '../../api/designs';
import type { Scope } from '../../api/scopes';
import { groupDesignsByScope, scopesWithNoDesigns } from './groupByScope';

const IDF_2: Scope = {
  scopeId: 'scope-idf-2',
  parentScopeId: null,
  kind: 'closet',
  displayName: 'IDF-2',
  depth: 0,
  path: 'scope-idf-2',
  capability: 'read',
};

const IDF_1: Scope = {
  scopeId: 'scope-idf-1',
  parentScopeId: null,
  kind: 'closet',
  displayName: 'IDF-1',
  depth: 0,
  path: 'scope-idf-1',
  capability: 'read',
};

function design(id: string, scopeId: string): DesignSummary {
  return {
    designId: id,
    scopeId,
    createdAtUnix: 1,
    createdBy: 'acct',
    capability: 'read',
    latestVersion: 1,
  };
}

describe('groupDesignsByScope', () => {
  it('groups designs under the scope they name, sorted by scope path', () => {
    const designs = [design('d1', 'scope-idf-2'), design('d2', 'scope-idf-1'), design('d3', 'scope-idf-2')];
    const result = groupDesignsByScope(designs, [IDF_2, IDF_1]);
    expect(result.groups.map((g) => g.scope.scopeId)).toEqual(['scope-idf-1', 'scope-idf-2']);
    expect(result.groups[1].designs.map((d) => d.designId)).toEqual(['d1', 'd3']);
    expect(result.elsewhere).toEqual([]);
  });

  it('puts a design whose scope did not come back into elsewhere, never inventing a name', () => {
    const designs = [design('d1', 'scope-unreadable')];
    const result = groupDesignsByScope(designs, [IDF_2]);
    expect(result.groups).toEqual([]);
    expect(result.elsewhere.map((d) => d.designId)).toEqual(['d1']);
  });

  it('preserves the caller-supplied order within a group', () => {
    const designs = [design('d2', 'scope-idf-2'), design('d1', 'scope-idf-2')];
    const result = groupDesignsByScope(designs, [IDF_2]);
    expect(result.groups[0].designs.map((d) => d.designId)).toEqual(['d2', 'd1']);
  });

  it('returns empty groups and elsewhere for no designs', () => {
    expect(groupDesignsByScope([], [IDF_2])).toEqual({ groups: [], elsewhere: [] });
  });
});

describe('scopesWithNoDesigns', () => {
  it('returns every scope no design names', () => {
    const designs = [design('d1', 'scope-idf-2')];
    expect(scopesWithNoDesigns([IDF_2, IDF_1], designs)).toEqual([IDF_1]);
  });

  it('returns all scopes when there are no designs at all — the empty-organisation case', () => {
    expect(scopesWithNoDesigns([IDF_2, IDF_1], [])).toEqual([IDF_2, IDF_1]);
  });

  it('returns none when every scope already has a design', () => {
    const designs = [design('d1', 'scope-idf-2'), design('d2', 'scope-idf-1')];
    expect(scopesWithNoDesigns([IDF_2, IDF_1], designs)).toEqual([]);
  });

  it('preserves the caller-supplied scope order', () => {
    expect(scopesWithNoDesigns([IDF_1, IDF_2], [])).toEqual([IDF_1, IDF_2]);
  });

  it('returns an empty list for an empty scope list', () => {
    expect(scopesWithNoDesigns([], [])).toEqual([]);
  });
});
