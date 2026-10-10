// The cable colour key: a legend built from the cables in this design. Each cable colour in use gets a
// line saying what most of its cables share, when they share something: a VLAN, a tag, or a kind of
// cable (fibre, DAC, power). Nothing shared reads "4 cables". Pure; the panel is `ColourKey.tsx`.
// Everything shared is read through the Cables list's own groups (`cableGroups.ts`), so the key and the
// list always agree about what a VLAN or a tag covers.

import type { Document } from '../../document/model';
import type { Sheath } from '../../document/cables';
import { CABLE_TYPE_GROUP_LABEL, availableCableGroupCandidates, resolveCableGroup } from './cableGroups';
import type { ClosetView } from './contract';

/** Something a set of cables can share, with the cables that have it. */
export interface Shareable {
  kind: 'vlan' | 'tag' | 'type';
  /** The words for it: "Staff VLAN 20", "Uplinks", "Fibre". */
  name: string;
  cableIds: ReadonlySet<string>;
}

export interface KeyRow {
  sheath: Sheath;
  /** "Blue". */
  colour: string;
  /** What most of the colour's cables share, or null. */
  shares: string | null;
  count: number;
  cableIds: ReadonlySet<string>;
  /** The row as one line: "Blue · Staff VLAN 20", or "Red · 4 cables". */
  text: string;
}

const COLOUR_WORDS: Partial<Record<Sheath, string>> = { erika: 'Violet' };

export function colourWord(sheath: Sheath): string {
  return COLOUR_WORDS[sheath] ?? sheath.charAt(0).toUpperCase() + sheath.slice(1);
}

const KIND_ORDER: Record<Shareable['kind'], number> = { vlan: 0, tag: 1, type: 2 };

/** "More than half" of the colour's cables have it. */
function isMost(shared: number, total: number): boolean {
  return shared * 2 > total;
}

/** The key rows from cables (with their colours) and the things they might share. Pure. Rows run from the
 * colour with most cables down; a cable with no colour set is drawn grey, so it counts as grey. */
export function buildKey(cables: ReadonlyArray<{ id: string; sheath: Sheath | null }>, shareables: readonly Shareable[]): KeyRow[] {
  const bySheath = new Map<Sheath, string[]>();
  for (const c of cables) {
    const s = c.sheath ?? 'grey';
    const list = bySheath.get(s);
    if (list) list.push(c.id);
    else bySheath.set(s, [c.id]);
  }
  const rows: KeyRow[] = [];
  for (const [sheath, ids] of bySheath) {
    let best: { name: string; shared: number; kind: Shareable['kind'] } | null = null;
    for (const s of shareables) {
      let shared = 0;
      for (const id of ids) if (s.cableIds.has(id)) shared += 1;
      if (!isMost(shared, ids.length)) continue;
      // More shared first, then a VLAN over a tag over a kind of cable, then the name for a steady order.
      const better =
        best === null ||
        shared > best.shared ||
        (shared === best.shared && (KIND_ORDER[s.kind] < KIND_ORDER[best.kind] || (s.kind === best.kind && s.name < best.name)));
      if (better) best = { name: s.name, shared, kind: s.kind };
    }
    const colour = colourWord(sheath);
    const shares = best?.name ?? null;
    const noun = ids.length === 1 ? 'cable' : 'cables';
    rows.push({ sheath, colour, shares, count: ids.length, cableIds: new Set(ids), text: `${colour} · ${shares ?? `${ids.length} ${noun}`}` });
  }
  rows.sort((a, b) => b.count - a.count || a.colour.localeCompare(b.colour));
  return rows;
}

/** The VLAN, tag and kind-of-cable groups of this design as things cables can share. Copper is left out:
 * it is what nearly every cable is, so saying it tells nobody anything. */
export function shareablesOf(doc: Document, view: ClosetView): Shareable[] {
  const out: Shareable[] = [];
  for (const candidate of availableCableGroupCandidates(doc, view)) {
    const ref = candidate.ref;
    if (ref.kind === 'device' || (ref.kind === 'type' && ref.type === 'copper')) continue;
    const resolved = resolveCableGroup(doc, view, ref);
    if (resolved == null || resolved.cableIds.size === 0) continue;
    if (ref.kind === 'vlan') out.push({ kind: 'vlan', name: vlanWords(candidate.name), cableIds: resolved.cableIds });
    else if (ref.kind === 'tag') out.push({ kind: 'tag', name: candidate.name, cableIds: resolved.cableIds });
    else out.push({ kind: 'type', name: CABLE_TYPE_GROUP_LABEL[ref.type], cableIds: resolved.cableIds });
  }
  return out;
}

/** The Cables list names a VLAN "VLAN 20 · Staff"; the key reads "Staff VLAN 20". */
export function vlanWords(listName: string): string {
  const m = /^VLAN (\d+)(?: · (.+))?$/.exec(listName);
  if (m == null) return listName;
  return m[2] != null && m[2] !== '' ? `${m[2]} VLAN ${m[1]}` : `VLAN ${m[1]}`;
}

/** The colour key for this design. Without a document (still loading) it can only count. */
export function colourKeyRows(doc: Document | null, view: ClosetView): KeyRow[] {
  const cables = view.cables ?? [];
  if (cables.length === 0) return [];
  return buildKey(cables, doc == null ? [] : shareablesOf(doc, view));
}
