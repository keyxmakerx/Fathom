// Where the Inventory list is, written into the address bar's hash so Back, a bookmark or a pasted
// link returns to the same list: kind, filter line, sort, Where, search, saved view and the open row.
// Pure. Defaults are left out, so the plain list is just "#inventory".

import { NO_WHERE, type Where } from './placeIndex';

export { NO_WHERE, type Where };

export interface SortKey {
  key: string;
  dir: 'asc' | 'desc';
}

export interface ListState {
  kind: string;
  q: string;
  sorts: SortKey[];
  where: Where;
  find: string;
  /** Saved view id the line came from, if any. */
  view: string;
  /** The open row's key, or '' for the list. */
  open: string;
  /** The open page's tab, if not the first. */
  tab: string;
}

export const DEFAULT_KIND = 'devices';

export const EMPTY_STATE: ListState = { kind: DEFAULT_KIND, q: '', sorts: [], where: NO_WHERE, find: '', view: '', open: '', tab: '' };

const PREFIX = '#inventory';

export function encodeSorts(sorts: readonly SortKey[]): string {
  return sorts.map((s) => `${s.key}:${s.dir}`).join(',');
}

export function decodeSorts(text: string): SortKey[] {
  const out: SortKey[] = [];
  for (const part of text.split(',')) {
    const i = part.lastIndexOf(':');
    if (i <= 0) continue;
    const dir = part.slice(i + 1);
    if (dir === 'asc' || dir === 'desc') out.push({ key: part.slice(0, i), dir });
  }
  return out;
}

export function formatHash(s: ListState): string {
  const p = new URLSearchParams();
  if (s.kind !== DEFAULT_KIND) p.set('k', s.kind);
  if (s.q) p.set('q', s.q);
  if (s.sorts.length) p.set('s', encodeSorts(s.sorts));
  if (s.where.site) p.set('site', s.where.site);
  if (s.where.row) p.set('row', s.where.row);
  if (s.where.rack) p.set('rack', s.where.rack);
  if (s.find) p.set('f', s.find);
  if (s.view) p.set('v', s.view);
  if (s.open) p.set('o', s.open);
  if (s.tab) p.set('t', s.tab);
  const text = p.toString();
  return text ? `${PREFIX}?${text}` : PREFIX;
}

/** Null when the hash is not the Inventory's. */
export function parseHash(hash: string): ListState | null {
  const h = hash.replace(/^#/, '');
  if (h !== 'inventory' && !h.startsWith('inventory?')) return null;
  const p = new URLSearchParams(h.slice('inventory?'.length));
  return {
    kind: p.get('k') || DEFAULT_KIND,
    q: p.get('q') ?? '',
    sorts: decodeSorts(p.get('s') ?? ''),
    where: { site: p.get('site') ?? '', row: p.get('row') ?? p.get('room') ?? '', rack: p.get('rack') ?? '' },
    find: p.get('f') ?? '',
    view: p.get('v') ?? '',
    open: p.get('o') ?? '',
    tab: p.get('t') ?? '',
  };
}

export function sameState(a: ListState, b: ListState): boolean {
  return formatHash(a) === formatHash(b);
}

/**
 * Back or Forward lands on an older entry, but Where is the one setting that is not the entry's:
 * a Where changed while a page was open (or since) is kept, so it survives the trip.
 */
export function carryWhere(landed: ListState, current: ListState): ListState {
  return { ...landed, where: current.where };
}

/** The Back label for the place being left: the open item, else the saved view that was open, else the kind. */
export function placeLabel(left: { openTitle?: string; viewName?: string; kindLabel: string }): string {
  return left.openTitle || left.viewName || left.kindLabel;
}
