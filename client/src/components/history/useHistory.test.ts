import { describe, expect, it } from 'vitest';

import type { HistoryEntry } from '../../api/history';
import { FETCH, savesOf, withNewest, withOlder } from './useHistory';

const entry = (seq: number, version = seq, entryType = 'change'): HistoryEntry => ({
  seq,
  entryType,
  designVersion: version,
  atUnix: 1_700_000_000 + seq,
  actor: 'account-1',
  viaAi: null,
});
const run = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => entry(from + i));

describe('History a page at a time', () => {
  it('lists one save per version, newest first, leaving out re-encryptions', () => {
    const saves = savesOf([entry(1), entry(2), entry(3, 2, 'reencrypt'), entry(4, 3)]);
    expect(saves.map((s) => s.designVersion)).toEqual([3, 2, 1]);
  });

  it('knows older saves exist when the newest page came back full', () => {
    expect(withNewest(null, run(101, 100 + FETCH)).hasOlder).toBe(true);
    expect(withNewest(null, run(1, 3)).hasOlder).toBe(false);
  });

  it('adds new changes on top and older pages below', () => {
    const first = withNewest(null, run(201, 200 + FETCH));
    const newer = withNewest(first, run(210, 209 + FETCH));
    expect(newer.entries.size).toBe(FETCH + 9);
    expect(newer.hasOlder).toBe(true);
    const older = withOlder(newer, run(150, 200));
    expect(older.entries.size).toBe(FETCH + 9 + 51);
    expect(older.hasOlder).toBe(false);
    expect(savesOf(older.entries.values())[0]?.designVersion).toBe(309);
  });

  it('starts again from the newest page when more landed than a page holds', () => {
    const first = withNewest(null, run(1, 50));
    const jumped = withNewest(first, run(500, 499 + FETCH));
    expect([...jumped.entries.keys()].sort((a, b) => a - b)[0]).toBe(500);
    expect(jumped.hasOlder).toBe(true);
  });
});
