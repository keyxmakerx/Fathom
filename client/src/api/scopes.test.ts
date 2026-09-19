import { describe, expect, it, vi } from 'vitest';

vi.mock('./signedFetch', () => ({
  signedFetch: vi.fn(),
}));

import { signedFetch } from './signedFetch';
import { buildScopeForest, createScope, parseScope, parseScopes, pathTo, type Scope } from './scopes';

const mockedSignedFetch = vi.mocked(signedFetch);

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** The mirror of `crypto::read_lp`, over the exact bytes `createScope` sent
 * — `crypto::lp` twice, parent then label — rather than `JSON.parse`, which
 * `create_scope_handler` never calls (design_api.rs's own doc on the
 * handler: two length-prefixed fields). */
function readTwoLpFields(bytes: Uint8Array): { parent: string; label: string } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parentLen = view.getUint32(0, true);
  const parentBytes = bytes.subarray(4, 4 + parentLen);
  const rest = bytes.subarray(4 + parentLen);
  const restView = new DataView(rest.buffer, rest.byteOffset, rest.byteLength);
  const labelLen = restView.getUint32(0, true);
  const labelBytes = rest.subarray(4, 4 + labelLen);
  return {
    parent: new TextDecoder().decode(parentBytes),
    label: new TextDecoder().decode(labelBytes),
  };
}

const HQ: Scope = {
  scopeId: 'scope-hq',
  parentScopeId: null,
  kind: 'site',
  displayName: 'HQ',
  depth: 0,
  path: 'scope-hq',
  capability: 'read',
};

const BUILDING_A: Scope = {
  scopeId: 'scope-building-a',
  parentScopeId: 'scope-hq',
  kind: 'building',
  displayName: 'Building A',
  depth: 1,
  path: 'scope-hq.scope-building-a',
  capability: 'read',
};

const IDF_2: Scope = {
  scopeId: 'scope-idf-2',
  parentScopeId: 'scope-building-a',
  kind: 'closet',
  displayName: 'IDF-2',
  depth: 2,
  path: 'scope-hq.scope-building-a.scope-idf-2',
  capability: 'draw',
};

// A scope whose direct parent is present but whose grandparent (HQ) was
// never sent — the caller may not read it, per the route's own contract.
const IDF_3_MISSING_GRANDPARENT: Scope = {
  scopeId: 'scope-idf-3',
  parentScopeId: 'scope-basement',
  kind: 'closet',
  displayName: 'IDF-3',
  depth: 2,
  path: 'scope-basement.scope-idf-3',
  capability: 'read',
};

describe('parseScopes', () => {
  it('parses a well-formed array, including a null parent_scope_id', () => {
    const body = JSON.stringify([
      {
        scope_id: 'scope-hq',
        parent_scope_id: null,
        kind: 'site',
        display_name: 'HQ',
        depth: 0,
        path: 'scope-hq',
        capability: 'read',
      },
    ]);
    expect(parseScopes(bytesOf(body))).toEqual([HQ]);
  });

  it('parses a scope with a string parent_scope_id', () => {
    const body = JSON.stringify([
      {
        scope_id: 'scope-building-a',
        parent_scope_id: 'scope-hq',
        kind: 'building',
        display_name: 'Building A',
        depth: 1,
        path: 'scope-hq.scope-building-a',
        capability: 'read',
      },
    ]);
    expect(parseScopes(bytesOf(body))).toEqual([BUILDING_A]);
  });

  it('accepts the empty array', () => {
    expect(parseScopes(bytesOf('[]'))).toEqual([]);
  });

  it('rejects a body that is not JSON', () => {
    expect(() => parseScopes(bytesOf('not json'))).toThrow(/not JSON/);
  });

  it('rejects a body that is not an array', () => {
    expect(() => parseScopes(bytesOf('{"scope_id":"x"}'))).toThrow(/not a JSON array/);
  });

  it('rejects an entry missing scope_id', () => {
    const body = JSON.stringify([
      { parent_scope_id: null, kind: 'site', display_name: 'HQ', depth: 0, path: 'x', capability: 'read' },
    ]);
    expect(() => parseScopes(bytesOf(body))).toThrow(/scope_id/);
  });

  it('rejects an entry whose parent_scope_id is neither null nor a string', () => {
    const body = JSON.stringify([
      {
        scope_id: 'scope-hq',
        parent_scope_id: 3,
        kind: 'site',
        display_name: 'HQ',
        depth: 0,
        path: 'x',
        capability: 'read',
      },
    ]);
    expect(() => parseScopes(bytesOf(body))).toThrow(/parent_scope_id/);
  });

  it('rejects an entry missing depth', () => {
    const body = JSON.stringify([
      {
        scope_id: 'scope-hq',
        parent_scope_id: null,
        kind: 'site',
        display_name: 'HQ',
        path: 'x',
        capability: 'read',
      },
    ]);
    expect(() => parseScopes(bytesOf(body))).toThrow(/depth/);
  });

  it('rejects an entry that is not an object', () => {
    expect(() => parseScopes(bytesOf('["not an object"]'))).toThrow(/not an object/);
  });
});

describe('parseScope', () => {
  it('parses a single object — the shape a create response answers with', () => {
    const record = {
      scope_id: 'scope-hq',
      parent_scope_id: null,
      kind: 'site',
      display_name: 'HQ',
      depth: 0,
      path: 'scope-hq',
      capability: 'steward',
    };
    expect(parseScope(record, 'the create response')).toEqual({ ...HQ, capability: 'steward' });
  });

  it('names the caller-given label in its refusal', () => {
    expect(() => parseScope({ kind: 'site' }, 'the create response')).toThrow(/the create response/);
  });
});

describe('createScope', () => {
  it('POSTs two length-prefixed fields to the scopes route and parses one scope', async () => {
    const created = {
      scope_id: 'scope-idf-4',
      parent_scope_id: 'scope-building-a',
      kind: 'closet',
      display_name: 'IDF-4',
      depth: 2,
      path: 'scope-hq.scope-building-a.scope-idf-4',
      capability: 'steward',
    };
    mockedSignedFetch.mockResolvedValueOnce(new TextEncoder().encode(JSON.stringify(created)));

    const scope = await createScope('org-1', 'scope-building-a', 'IDF-4');

    expect(scope).toEqual({
      scopeId: created.scope_id,
      parentScopeId: created.parent_scope_id,
      kind: created.kind,
      displayName: created.display_name,
      depth: created.depth,
      path: created.path,
      capability: created.capability,
    });

    const [method, path, sentBody] = mockedSignedFetch.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/organisations/org-1/scopes');
    expect(readTwoLpFields(sentBody as Uint8Array)).toEqual({ parent: 'scope-building-a', label: 'IDF-4' });
  });

  it('rejects a response body that is not JSON', async () => {
    mockedSignedFetch.mockResolvedValueOnce(new TextEncoder().encode('not json'));
    await expect(createScope('org-1', 'scope-building-a', 'IDF-4')).rejects.toThrow(/not JSON/);
  });

  it('sends a null parent unchanged — the "of the organisation" bootstrap case', async () => {
    const created = {
      scope_id: 'scope-hq',
      parent_scope_id: null,
      kind: 'site',
      display_name: 'HQ',
      depth: 0,
      path: 'scope-hq',
      capability: 'steward',
    };
    mockedSignedFetch.mockResolvedValueOnce(new TextEncoder().encode(JSON.stringify(created)));
    await createScope('org-1', null, 'HQ');
    const [, , sentBody] = mockedSignedFetch.mock.calls[0];
    expect(readTwoLpFields(sentBody as Uint8Array)).toEqual({ parent: '', label: 'HQ' });
  });
});

describe('buildScopeForest', () => {
  it('nests children under their parent, sorted by path', () => {
    const forest = buildScopeForest([IDF_2, HQ, BUILDING_A]);
    expect(forest).toEqual([
      { scope: HQ, children: [{ scope: BUILDING_A, children: [{ scope: IDF_2, children: [] }] }] },
    ]);
  });

  it('treats a scope whose parent id is absent from the set as an extra root', () => {
    const forest = buildScopeForest([IDF_3_MISSING_GRANDPARENT]);
    expect(forest).toEqual([{ scope: IDF_3_MISSING_GRANDPARENT, children: [] }]);
  });

  it('allows several roots at once, sorted by path', () => {
    // "scope-basement..." sorts before "scope-hq" — the missing-ancestor
    // root comes first, HQ (with Building A nested beneath it) second.
    const forest = buildScopeForest([BUILDING_A, HQ, IDF_3_MISSING_GRANDPARENT]);
    expect(forest.map((node) => node.scope.scopeId)).toEqual(['scope-idf-3', 'scope-hq']);
    expect(forest[1].children.map((node) => node.scope.scopeId)).toEqual(['scope-building-a']);
  });

  it('returns an empty forest for an empty scope list', () => {
    expect(buildScopeForest([])).toEqual([]);
  });
});

describe('pathTo', () => {
  it('builds the full chain when every ancestor is present', () => {
    expect(pathTo([HQ, BUILDING_A, IDF_2], 'scope-idf-2')).toEqual([HQ, BUILDING_A, IDF_2]);
  });

  it('starts from the highest ancestor actually present when one is missing', () => {
    // scope-basement (the parent) never came back — only the leaf did.
    expect(pathTo([IDF_3_MISSING_GRANDPARENT], 'scope-idf-3')).toEqual([IDF_3_MISSING_GRANDPARENT]);
  });

  it('returns a single-element chain for a root scope', () => {
    expect(pathTo([HQ, BUILDING_A], 'scope-hq')).toEqual([HQ]);
  });

  it('returns an empty chain when the target scope itself is absent', () => {
    expect(pathTo([HQ, BUILDING_A], 'scope-does-not-exist')).toEqual([]);
  });

  it('never invents an ancestor: a mid-chain gap stops the walk there', () => {
    // Building A is missing; IDF-2 still links to it via parent_scope_id.
    expect(pathTo([HQ, IDF_2], 'scope-idf-2')).toEqual([IDF_2]);
  });
});
