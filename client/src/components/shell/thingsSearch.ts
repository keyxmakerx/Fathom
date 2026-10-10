// The palette's "Things": the quick search's hits, plus what Inventory's Find would add — an IP or
// MAC address, a serial, a port spelled the way a vendor spells it. Pure; nothing here writes.

import type { Document } from '../../document/model';
import type { ClosetView } from '../../document/view';
import { cableRows, deviceRows, portRows, rackRows, type Kind } from '../inventory/kinds';
import { NO_WHERE, buildPlaceIndex } from '../inventory/placeIndex';
import { buildSearchIndex, search, type SearchIndex } from '../inventory/search';
import { searchDesign, type SearchHit } from './search';

const GROUP_OF: Partial<Record<Kind, SearchHit['group']>> = {
  devices: 'Devices',
  racks: 'Racks',
  ports: 'Ports',
  cables: 'Cables',
  vlans: 'VLANs',
};

const GROUP_ORDER: readonly SearchHit['group'][] = ['Devices', 'Racks', 'Ports', 'Cables', 'VLANs', 'Containers'];

const keyOf = (h: SearchHit): string => `${h.selection.kind}:${h.selection.id}`;

/** Merges two lists of hits, dropping repeats of the same thing, grouped in the usual order and capped. */
export function mergeHits(first: readonly SearchHit[], more: readonly SearchHit[], limit = 20): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const h of [...first, ...more]) {
    const key = keyOf(h);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  out.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  return out.slice(0, limit);
}

/** What Inventory's Find finds for this clue, as quick-search hits. Only sure matches (not "nearest names"). */
export function inventoryHits(ix: SearchIndex, clue: string): SearchHit[] {
  const outcome = search(ix, clue, NO_WHERE);
  const hits: SearchHit[] = [];
  for (const group of outcome.groups) {
    const label = GROUP_OF[group.kind];
    if (label === undefined) continue;
    for (const h of group.hits) {
      if (h.how === 'near' || h.row.selection === null) continue;
      hits.push({ group: label, name: h.row.title, why: h.why, selection: h.row.selection });
    }
  }
  return hits;
}

/** Builds the Find index once per document and answers every keystroke from it. */
export function createThingsFinder() {
  let built: { doc: Document; view: ClosetView; ix: SearchIndex } | null = null;
  return function find(doc: Document, view: ClosetView, query: string): SearchHit[] {
    const quick = searchDesign(view, query, doc);
    if (query.trim() === '') return quick;
    if (built === null || built.doc !== doc || built.view !== view) {
      const idx = buildPlaceIndex(doc, view);
      built = {
        doc,
        view,
        ix: buildSearchIndex({
          devices: deviceRows(doc, view, [], idx),
          ports: portRows(doc, view, idx, []),
          racks: rackRows(doc, view, [], idx),
          cables: cableRows(doc, view, idx, []),
          idx,
        }),
      };
    }
    return mergeHits(quick, inventoryHits(built.ix, query));
  };
}
