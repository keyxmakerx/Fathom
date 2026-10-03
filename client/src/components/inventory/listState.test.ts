import { describe, expect, it } from 'vitest';

import { EMPTY_STATE, formatHash, parseHash, type ListState } from './listState';
import { nextSorts, sortRows } from './sorting';
import type { InvRow } from './kinds';

const row = (key: string, cells: Record<string, string>, nums?: Record<string, number>): InvRow => ({
  key,
  selection: null,
  ownerId: null,
  cells,
  tags: [],
  ids: {},
  title: key,
  nums,
});

describe('the list in the address bar', () => {
  it('the plain list is just #inventory', () => {
    expect(formatHash(EMPTY_STATE)).toBe('#inventory');
    expect(parseHash('#inventory')).toEqual(EMPTY_STATE);
  });

  it('kind, filter line, sorts, Where, search, view, open row and tab round-trip', () => {
    const s: ListState = {
      kind: 'cables',
      q: 'label:empty (a.role:switch | b.role:switch) name~"core 1"',
      sorts: [
        { key: 'length', dir: 'desc' },
        { key: 'name', dir: 'asc' },
      ],
      where: { site: 'LON1', row: 'Row A', rack: 'A03' },
      find: 'ge0/0/24',
      view: 'v4',
      open: 'cable:01HZZZZZZZZZZZZZZZZZZZZZZZ',
      tab: 'history',
    };
    expect(parseHash(formatHash(s))).toEqual(s);
  });

  it('is not the inventory when the hash is something else', () => {
    expect(parseHash('')).toBeNull();
    expect(parseHash('#inv_abc')).toBeNull();
    expect(parseHash('#reset=abc')).toBeNull();
  });

  it('ignores a malformed sort', () => {
    const s = parseHash('#inventory?s=name:up,length:desc,junk')!;
    expect(s.sorts).toEqual([{ key: 'length', dir: 'desc' }]);
  });

  it('Back from a page is the same list: only the open row and tab differ', () => {
    const list: ListState = { ...EMPTY_STATE, kind: 'devices', q: 'role:switch', sorts: [{ key: 'name', dir: 'asc' }], where: { site: 'LON1', row: '', rack: '' } };
    const opened: ListState = { ...list, open: 'chassis:X', tab: '' };
    const page = parseHash(formatHash(opened))!;
    const back = { ...page, open: '', tab: '' };
    expect(formatHash(back)).toBe(formatHash(list));
    expect(back.q).toBe('role:switch');
    expect(back.sorts).toEqual(list.sorts);
    expect(back.where.site).toBe('LON1');
  });
});

describe('sorting', () => {
  const rows = [
    row('a', { name: 'rack-10', length: '5' }, { length: 5 }),
    row('b', { name: 'rack-2', length: '40' }, { length: 40 }),
    row('c', { name: 'rack-2', length: '' }),
    row('d', { name: '', length: '40' }, { length: 40 }),
  ];
  const keys = (rs: InvRow[]) => rs.map((r) => r.key);

  it('sorts names naturally and puts blanks first going up', () => {
    expect(keys(sortRows(rows, [{ key: 'name', dir: 'asc' }]))).toEqual(['d', 'b', 'c', 'a']);
    expect(keys(sortRows(rows, [{ key: 'name', dir: 'desc' }]))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a second sort breaks ties', () => {
    expect(keys(sortRows(rows, [{ key: 'name', dir: 'asc' }, { key: 'length', dir: 'desc' }]))).toEqual(['d', 'b', 'c', 'a']);
    expect(keys(sortRows(rows, [{ key: 'length', dir: 'desc' }, { key: 'name', dir: 'asc' }]))).toEqual(['d', 'b', 'a', 'c']);
  });

  it('a plain click goes up, down, off; a shift-click adds or flips', () => {
    let s = nextSorts([], 'name', false);
    expect(s).toEqual([{ key: 'name', dir: 'asc' }]);
    s = nextSorts(s, 'name', false);
    expect(s).toEqual([{ key: 'name', dir: 'desc' }]);
    s = nextSorts(s, 'name', false);
    expect(s).toEqual([]);
    s = nextSorts([{ key: 'name', dir: 'asc' }], 'length', true);
    expect(s).toEqual([{ key: 'name', dir: 'asc' }, { key: 'length', dir: 'asc' }]);
    s = nextSorts(s, 'length', true);
    expect(s[1]).toEqual({ key: 'length', dir: 'desc' });
    expect(nextSorts(s, 'tags', false)).toEqual([{ key: 'tags', dir: 'asc' }]);
  });
});
