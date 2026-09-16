import { describe, expect, it } from 'vitest';

import { parseDesigns, sortDesignsByRecency, type DesignSummary } from './designs';

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const ROW_A = {
  design_id: '01JQZ0000000000000000000D1',
  scope_id: '01JQZ0000000000000000000S1',
  created_at_unix: 100,
  created_by: '01JQZ0000000000000000000AA',
  capability: 'read',
  latest_version: 3,
};

const ROW_B = {
  design_id: '01JQZ0000000000000000000D2',
  scope_id: '01JQZ0000000000000000000S2',
  created_at_unix: 200,
  created_by: '01JQZ0000000000000000000AB',
  capability: 'steward',
  latest_version: 1,
};

describe('parseDesigns', () => {
  it('parses a well-formed array', () => {
    expect(parseDesigns(bytesOf(JSON.stringify([ROW_A, ROW_B])))).toEqual([
      {
        designId: ROW_A.design_id,
        scopeId: ROW_A.scope_id,
        createdAtUnix: 100,
        createdBy: ROW_A.created_by,
        capability: 'read',
        latestVersion: 3,
      },
      {
        designId: ROW_B.design_id,
        scopeId: ROW_B.scope_id,
        createdAtUnix: 200,
        createdBy: ROW_B.created_by,
        capability: 'steward',
        latestVersion: 1,
      },
    ]);
  });

  it('accepts the empty array — no design the account may see', () => {
    expect(parseDesigns(bytesOf('[]'))).toEqual([]);
  });

  it('rejects a body that is not JSON', () => {
    expect(() => parseDesigns(bytesOf('<<not json>>'))).toThrow(/not JSON/);
  });

  it('rejects a body that is not an array', () => {
    expect(() => parseDesigns(bytesOf('{}'))).toThrow(/not a JSON array/);
  });

  it('rejects an entry missing design_id', () => {
    const { design_id: _dropped, ...rest } = ROW_A;
    expect(() => parseDesigns(bytesOf(JSON.stringify([rest])))).toThrow(/design_id/);
  });

  it('rejects an entry with a non-numeric created_at_unix', () => {
    const bad = { ...ROW_A, created_at_unix: '100' };
    expect(() => parseDesigns(bytesOf(JSON.stringify([bad])))).toThrow(/created_at_unix/);
  });

  it('rejects an entry with a non-numeric latest_version', () => {
    const bad = { ...ROW_A, latest_version: '3' };
    expect(() => parseDesigns(bytesOf(JSON.stringify([bad])))).toThrow(/latest_version/);
  });
});

describe('sortDesignsByRecency', () => {
  it('orders most-recent-first', () => {
    const oldest: DesignSummary = { designId: 'a', scopeId: 's', createdAtUnix: 1, createdBy: 'x', capability: 'read', latestVersion: 1 };
    const newest: DesignSummary = { designId: 'b', scopeId: 's', createdAtUnix: 3, createdBy: 'x', capability: 'read', latestVersion: 1 };
    const middle: DesignSummary = { designId: 'c', scopeId: 's', createdAtUnix: 2, createdBy: 'x', capability: 'read', latestVersion: 1 };
    expect(sortDesignsByRecency([oldest, newest, middle]).map((d) => d.designId)).toEqual(['b', 'c', 'a']);
  });

  it('is stable — equal timestamps keep the server-given order', () => {
    const first: DesignSummary = { designId: 'first', scopeId: 's', createdAtUnix: 5, createdBy: 'x', capability: 'read', latestVersion: 1 };
    const second: DesignSummary = { designId: 'second', scopeId: 's', createdAtUnix: 5, createdBy: 'x', capability: 'read', latestVersion: 1 };
    expect(sortDesignsByRecency([first, second]).map((d) => d.designId)).toEqual(['first', 'second']);
  });

  it('does not mutate its input', () => {
    const input: DesignSummary[] = [
      { designId: 'a', scopeId: 's', createdAtUnix: 1, createdBy: 'x', capability: 'read', latestVersion: 1 },
      { designId: 'b', scopeId: 's', createdAtUnix: 2, createdBy: 'x', capability: 'read', latestVersion: 1 },
    ];
    const copy = [...input];
    sortDesignsByRecency(input);
    expect(input).toEqual(copy);
  });
});
