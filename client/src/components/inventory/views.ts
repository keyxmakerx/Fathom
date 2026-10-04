// Saved views: a kind, a filter line and a sort, kept under the kind in the side list.
//   Pinned  - ours, built in: questions that need no setting up.
//   Mine    - saved by this person, kept in this browser (localStorage).
//   Shared  - reserved. Sharing a view with the team needs somewhere on the server to keep it.

import type { SortKey } from './listState';

export type Who = 'Mine' | 'Shared' | 'Pinned';

export interface SavedView {
  id: string;
  kind: string;
  name: string;
  q: string;
  sorts: SortKey[];
  who: Who;
}

const pinned = (kind: string, id: string, name: string, q: string, sorts: SortKey[] = []): SavedView => ({ id: `pin:${id}`, kind, name, q, sorts, who: 'Pinned' });

/** Only fields that exist in the schema and in this list's columns. */
export const PINNED_VIEWS: readonly SavedView[] = [
  pinned('devices', 'dev-unplaced', 'Not in a rack', 'where:empty'),
  pinned('devices', 'dev-no-mgmt', 'No mgmt address', 'mgmt:empty'),
  pinned('devices', 'dev-no-serial', 'No serial', 'serial:empty'),
  pinned('ports', 'port-free', 'Not cabled', 'cable:empty'),
  pinned('ports', 'port-uplink', 'Uplinks', 'uplink:yes'),
  pinned('racks', 'rack-nearly-full', 'Nearly full', 'free<=4'),
  pinned('racks', 'rack-empty', 'Empty', 'devices:0'),
  pinned('cables', 'cab-unlabelled', 'Unlabelled', 'name:empty'),
  pinned('cables', 'cab-no-length', 'No length', 'length:empty'),
  pinned('cables', 'cab-fibre', 'Fibre', 'kind:fibre'),
];

const STORE = 'fathom.inventory.views';

export function parseMine(raw: string | null): SavedView[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is SavedView =>
        typeof x === 'object' && x !== null && typeof x.id === 'string' && typeof x.kind === 'string' && typeof x.name === 'string' && typeof x.q === 'string' && Array.isArray(x.sorts),
    ).map((x) => ({ ...x, who: 'Mine' as const }));
  } catch {
    return [];
  }
}

export function loadMine(): SavedView[] {
  try {
    return parseMine(window.localStorage.getItem(STORE));
  } catch {
    return [];
  }
}

export function saveMine(views: readonly SavedView[]): void {
  try {
    window.localStorage.setItem(STORE, JSON.stringify(views.filter((v) => v.who === 'Mine')));
  } catch {
    // Storage can be blocked; the view then lasts only this visit.
  }
}

export function addMine(views: readonly SavedView[], kind: string, name: string, q: string, sorts: readonly SortKey[], id: string): SavedView[] {
  const clean = name.trim() || 'My view';
  return [...views.filter((v) => !(v.who === 'Mine' && v.kind === kind && v.name === clean)), { id, kind, name: clean, q, sorts: [...sorts], who: 'Mine' }];
}

export const removeMine = (views: readonly SavedView[], id: string): SavedView[] => views.filter((v) => v.id !== id);

export const updateMine = (views: readonly SavedView[], id: string, q: string, sorts: readonly SortKey[]): SavedView[] =>
  views.map((v) => (v.id === id && v.who === 'Mine' ? { ...v, q, sorts: [...sorts] } : v));

/** Everything a kind shows under it: pinned first, then mine, then shared. */
export function viewsFor(all: readonly SavedView[], kind: string): SavedView[] {
  const order: Record<Who, number> = { Pinned: 0, Mine: 1, Shared: 2 };
  return all.filter((v) => v.kind === kind).sort((a, b) => order[a.who] - order[b.who]);
}
