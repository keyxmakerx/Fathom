// What a list remembers while you are away from it: how far it was scrolled, which rows were
// ticked and which row you opened. Kept in sessionStorage under the list's address (the address
// already holds the filter, sort, Where and view), so Back, a reload, or Back after Find can put
// it all back. Pure apart from the storage handed in.

import { formatHash, type ListState } from './listState';

export interface ListMemory {
  top: number;
  checked: string[];
  lastOpened: string | null;
}

/** More ticked rows than this are not remembered: the list comes back scrolled, nothing ticked. */
export const MAX_REMEMBERED_TICKS = 5000;

export interface MemoryStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The list's own address: the state without the open page, its tab and the search box. */
export function listKey(ls: ListState): string {
  return `fathom.inventory.list.${formatHash({ ...ls, open: '', tab: '', find: '' })}`;
}

export function saveMemory(store: MemoryStore, key: string, m: ListMemory): void {
  try {
    const keep: ListMemory = { top: Math.max(0, Math.round(m.top)), checked: m.checked.length > MAX_REMEMBERED_TICKS ? [] : m.checked, lastOpened: m.lastOpened };
    store.setItem(key, JSON.stringify(keep));
  } catch {
    // Storage can be full or blocked; the list then comes back at the top.
  }
}

export function loadMemory(store: MemoryStore, key: string): ListMemory | null {
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const m: unknown = JSON.parse(raw);
    if (typeof m !== 'object' || m === null) return null;
    const o = m as Record<string, unknown>;
    return {
      top: typeof o.top === 'number' && o.top >= 0 ? o.top : 0,
      checked: Array.isArray(o.checked) ? o.checked.filter((x): x is string => typeof x === 'string') : [],
      lastOpened: typeof o.lastOpened === 'string' ? o.lastOpened : null,
    };
  } catch {
    return null;
  }
}
