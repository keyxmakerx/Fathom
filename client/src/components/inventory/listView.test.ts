import { describe, expect, it } from 'vitest';

import { EMPTY_STATE, carryWhere, type ListState } from './listState';
import { linkTarget } from './links';
import { MAX_REMEMBERED_TICKS, listKey, loadMemory, saveMemory, type MemoryStore } from './listView';

const memory = (): MemoryStore & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
};

describe('links inside a page are pages in the list they belong to', () => {
  it('maps each selection to its kind and the row key the list uses', () => {
    expect(linkTarget({ kind: 'chassis', id: 'Chassis:1' })).toEqual({ kind: 'devices', open: 'chassis:Chassis:1' });
    expect(linkTarget({ kind: 'occupant', id: 'X' })).toEqual({ kind: 'devices', open: 'occupant:X' });
    expect(linkTarget({ kind: 'rack', id: 'R' })).toEqual({ kind: 'racks', open: 'rack:R' });
    expect(linkTarget({ kind: 'cable', id: 'C' })).toEqual({ kind: 'cables', open: 'cable:C' });
    expect(linkTarget({ kind: 'port', id: 'P' })).toEqual({ kind: 'ports', open: 'port:P' });
    expect(linkTarget({ kind: 'label', id: 'L' })).toBeNull();
  });
});

describe('a list remembers its scroll and ticks under its own address', () => {
  const list: ListState = { ...EMPTY_STATE, kind: 'cables', q: 'sheath:blue', sorts: [{ key: 'length', dir: 'desc' }], where: { site: 'LON1', row: '', rack: '' } };

  it('the key ignores the open page, its tab and the search box, but not the filter', () => {
    expect(listKey({ ...list, open: 'cable:X', tab: 'history', find: 'abc' })).toBe(listKey(list));
    expect(listKey({ ...list, q: 'sheath:red' })).not.toBe(listKey(list));
    expect(listKey({ ...list, where: { site: 'MAN1', row: '', rack: '' } })).not.toBe(listKey(list));
  });

  it('saves and loads, and two lists do not share', () => {
    const store = memory();
    saveMemory(store, listKey(list), { top: 1234.6, checked: ['cable:A', 'cable:B'], lastOpened: 'cable:B' });
    expect(loadMemory(store, listKey(list))).toEqual({ top: 1235, checked: ['cable:A', 'cable:B'], lastOpened: 'cable:B' });
    expect(loadMemory(store, listKey({ ...list, q: '' }))).toBeNull();
  });

  it('survives junk in storage, and keeps the scroll when too many rows are ticked to keep', () => {
    const store = memory();
    store.setItem('k', '{"top":"x","checked":[1,"a"]}');
    expect(loadMemory(store, 'k')).toEqual({ top: 0, checked: ['a'], lastOpened: null });
    store.setItem('k2', 'not json');
    expect(loadMemory(store, 'k2')).toBeNull();
    saveMemory(store, 'k3', { top: 90, checked: Array.from({ length: MAX_REMEMBERED_TICKS + 1 }, (_, i) => `r${i}`), lastOpened: null });
    expect(loadMemory(store, 'k3')).toEqual({ top: 90, checked: [], lastOpened: null });
  });
});

describe('Where changed while a page was open survives Back', () => {
  it('keeps the current Where over the older entry it lands on', () => {
    const landed: ListState = { ...EMPTY_STATE, kind: 'racks', q: 'free<10', where: { site: '', row: '', rack: '' } };
    const current: ListState = { ...EMPTY_STATE, kind: 'racks', open: 'rack:R', where: { site: 'LON1', row: 'Row A', rack: 'A03' } };
    const back = carryWhere(landed, current);
    expect(back.where).toEqual({ site: 'LON1', row: 'Row A', rack: 'A03' });
    expect(back.q).toBe('free<10');
    expect(back.open).toBe('');
  });
});
