import { describe, expect, it } from 'vitest';

import { PINNED_VIEWS, addMine, parseMine, removeMine, updateMine, viewsFor } from './views';
import { parseQuery } from './query';
import { allColumns } from './kinds';
import { schemaFor } from './rowQuery';
import type { Kind } from './kinds';

describe('saved views', () => {
  it('every pinned view names only fields its list has', () => {
    for (const v of PINNED_VIEWS) {
      const schema = schemaFor(v.kind, allColumns(v.kind as Kind, []));
      expect(parseQuery(v.q, schema.fields, v.kind).errors, v.name).toEqual([]);
    }
  });

  it('adds mine, replacing one of the same name, and keeps them out of the pinned set', () => {
    let mine = addMine([], 'cables', 'Long runs', 'length>30', [], 'm1');
    mine = addMine(mine, 'cables', 'Long runs', 'length>40', [{ key: 'length', dir: 'desc' }], 'm2');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: 'm2', q: 'length>40', who: 'Mine' });
    expect(addMine(mine, 'cables', '  ', 'x', [], 'm3').at(-1)!.name).toBe('My view');
    expect(removeMine(mine, 'm2')).toEqual([]);
    expect(updateMine(mine, 'm2', 'length>50', [])[0]!.q).toBe('length>50');
  });

  it('lists a kind pinned first, then mine', () => {
    const all = [...addMine([], 'cables', 'Mine one', 'x', [], 'm1'), ...PINNED_VIEWS];
    const got = viewsFor(all, 'cables');
    expect(got[0]!.who).toBe('Pinned');
    expect(got.at(-1)!.who).toBe('Mine');
    expect(viewsFor(all, 'networks')).toEqual([]);
  });

  it('reads stored views defensively', () => {
    expect(parseMine(null)).toEqual([]);
    expect(parseMine('not json')).toEqual([]);
    expect(parseMine('{"a":1}')).toEqual([]);
    expect(parseMine(JSON.stringify([{ id: 'a', kind: 'cables', name: 'n', q: 'x', sorts: [], who: 'Pinned' }, { nope: 1 }]))).toEqual([
      { id: 'a', kind: 'cables', name: 'n', q: 'x', sorts: [], who: 'Mine' },
    ]);
  });
});
