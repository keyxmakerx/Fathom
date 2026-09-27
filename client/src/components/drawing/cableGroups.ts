/**
 * GitHub issue #54 — the Cables list. Replaces `CablesViewControl`'s single
 * "all · copper · fibre · power · none" choice with several named groups,
 * any number on at once, each a VLAN row, a tag, a media type or a device.
 *
 * Pure: no DOM, no React. Three layers, in the order below —
 *
 *  1. Storage (`load`/`saveCableGroupsState`, `localStorage`, wrapped in
 *     try/catch like `cableVisibility.ts`) — one JSON object per design,
 *     never the document, never undo.
 *  2. Resolution (`resolveCableGroup`) — turns a stored REFERENCE (a VLAN's
 *     row key, a tag's fold key, a type name, a device's node id — never a
 *     name, which can change) into the cable ids it currently means, or
 *     `null` when the reference no longer resolves (the row/tag/device is
 *     gone) — the caller drops that row rather than show a broken one.
 *  3. The draw rule (`computeCableDraw`) — hidden-one-at-a-time cables never
 *     draw; otherwise None hides everything, a ticked group's cables draw,
 *     no ticked group draws every cable, and All/None are shortcuts that
 *     untick every group.
 */

import type { Document } from '../../document/model';
import { cablesCarryingVlan, deriveNetworks, trunkCableIdsForVlan } from '../../document/networks-derive';
import { foldTagName, listTags, objectsInTagGroupByFold, tagGroupByFold } from '../../document/tags';
import type { FixtureView } from '../../document/view';
import type { CableVisibility } from './cableVisibility';
import type { CableView, ClosetView } from './contract';

// ---------------------------------------------------------------------------
// Type groups — decision 5: "Type, from CableView.media."

export type CableTypeGroup = 'copper' | 'fibre' | 'dac' | 'power';

export const CABLE_TYPE_GROUPS: readonly CableTypeGroup[] = ['copper', 'fibre', 'dac', 'power'];

export const CABLE_TYPE_GROUP_LABEL: Record<CableTypeGroup, string> = {
  copper: 'Copper',
  fibre: 'Fibre',
  dac: 'DAC',
  power: 'Power',
};

const FIBRE_MEDIA = new Set(['smf', 'mmf']);

/** Copper: cat5e, cat6, cat6a, coax, virtual, other or unset (`''`). Fibre:
 * smf, mmf. DAC: twinax. Power: power. */
export function cableTypeGroupOf(media: string): CableTypeGroup {
  if (media === 'power') return 'power';
  if (media === 'twinax') return 'dac';
  if (FIBRE_MEDIA.has(media)) return 'fibre';
  return 'copper';
}

// ---------------------------------------------------------------------------
// References — decision 5: "Store each group by a stable reference."

export type CableGroupRef =
  | { kind: 'vlan'; key: string }
  | { kind: 'tag'; fold: string }
  | { kind: 'type'; type: CableTypeGroup }
  | { kind: 'device'; nodeId: string };

export function cableGroupRefKey(ref: CableGroupRef): string {
  switch (ref.kind) {
    case 'vlan':
      return `vlan:${ref.key}`;
    case 'tag':
      return `tag:${ref.fold}`;
    case 'type':
      return `type:${ref.type}`;
    case 'device':
      return `device:${ref.nodeId}`;
  }
}

// ---------------------------------------------------------------------------
// Stored state — decision 8: "localStorage, one key per design."

export interface StoredCableGroup {
  ref: CableGroupRef;
  on: boolean;
}

export interface StoredCableGroupsState {
  groups: StoredCableGroup[];
  none: boolean;
  /** Decision 6 — hidden one cable at a time, never a group; kept alongside
   * the groups because both live under the one per-design key. */
  hiddenCableIds: string[];
}

function storageKey(designId: string): string {
  return `fathom.cables.${designId}`;
}

function isCableGroupRef(v: unknown): v is CableGroupRef {
  if (v == null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r.kind === 'vlan') return typeof r.key === 'string';
  if (r.kind === 'tag') return typeof r.fold === 'string';
  if (r.kind === 'type') return typeof r.type === 'string' && (CABLE_TYPE_GROUPS as readonly string[]).includes(r.type);
  if (r.kind === 'device') return typeof r.nodeId === 'string';
  return false;
}

function isStoredCableGroup(v: unknown): v is StoredCableGroup {
  if (v == null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.on === 'boolean' && isCableGroupRef(r.ref);
}

function isStoredCableGroupsState(v: unknown): v is StoredCableGroupsState {
  if (v == null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (typeof r.none !== 'boolean') return false;
  if (!Array.isArray(r.groups) || !r.groups.every(isStoredCableGroup)) return false;
  if (!Array.isArray(r.hiddenCableIds) || !r.hiddenCableIds.every((id) => typeof id === 'string')) return false;
  return true;
}

/** `null` when nothing valid is stored yet for this design — the caller
 * falls back to a migrated choice or the default (`initialCableGroupsState`,
 * below). `localStorage` wrapped in try/catch, `cableVisibility.ts`'s own
 * reasoning: private browsing, a disabled storage API or a full quota all
 * throw on some engines, none of them a reason the list should fail to
 * open. */
export function loadCableGroupsState(designId: string): StoredCableGroupsState | null {
  try {
    const raw = localStorage.getItem(storageKey(designId));
    if (raw == null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isStoredCableGroupsState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Best-effort only, `cableVisibility.ts`'s own `saveCableVisibility`: a
 * save that fails leaves whatever was already stored rather than throwing
 * out of a click handler. Never a document fact — this key is never sent to
 * the server and never enters undo. */
export function saveCableGroupsState(designId: string, state: StoredCableGroupsState): void {
  try {
    localStorage.setItem(storageKey(designId), JSON.stringify(state));
  } catch {
    // best effort only
  }
}

// ---------------------------------------------------------------------------
// Defaults and the one-time migration — decision 1.

/** "With nothing stored for a design, the list starts with the types that
 * occur in the view, all unticked." */
export function defaultCableGroupsState(view: ClosetView): StoredCableGroupsState {
  const present = new Set((view.cables ?? []).map((c) => cableTypeGroupOf(c.media)));
  const groups: StoredCableGroup[] = CABLE_TYPE_GROUPS.filter((type) => present.has(type)).map((type) => ({
    ref: { kind: 'type', type },
    on: false,
  }));
  return { groups, none: false, hiddenCableIds: [] };
}

/** Decision 1 — "A stored old choice carries over once: copper, fibre or
 * power becomes that type group, ticked; none becomes None." Pure: takes
 * the old `CablesViewControl` choice (`cableVisibility.ts`'s own
 * `loadCableVisibility`, read by the caller) and turns it into a fresh
 * state; the caller persists it so the next open of this same design reads
 * its own stored state instead — "once" per design, not on every open. */
export function cableGroupsStateFromOldVisibility(old: CableVisibility, view: ClosetView): StoredCableGroupsState {
  const base = defaultCableGroupsState(view);
  if (old === 'all') return base;
  if (old === 'none') return { ...base, none: true };
  const key = cableGroupRefKey({ kind: 'type', type: old });
  const alreadyListed = base.groups.some((g) => cableGroupRefKey(g.ref) === key);
  const groups = alreadyListed
    ? base.groups.map((g) => (cableGroupRefKey(g.ref) === key ? { ...g, on: true } : g))
    : [...base.groups, { ref: { kind: 'type', type: old }, on: true }];
  return { groups, none: false, hiddenCableIds: [] };
}

// ---------------------------------------------------------------------------
// Resolution — decision 5's membership rules, one per kind.

export type CableGroupKindLabel = 'VLAN' | 'TAG' | 'TYPE' | 'DEVICE';

export interface ResolvedCableGroup {
  ref: CableGroupRef;
  kindLabel: CableGroupKindLabel;
  name: string;
  cableIds: ReadonlySet<string>;
  /** VLAN only — decision 5: "A cable that carries the VLAN tagged draws
   * dashed while the group is on: a trunk member at either end of its path,
   * through passive hops." A subset of `cableIds`. */
  dashedCableIds?: ReadonlySet<string>;
}

function realEnds(cable: CableView): Array<{ portId: string; chassisId: string }> {
  return cable.ends.filter((e): e is { portId: string; chassisId: string; rackId: string | null } => 'portId' in e);
}

/** Every rack chassis's and every unplaced chassis's own `Device` node id —
 * a cable end's `chassisId` is the `Chassis` node (`document/view.ts`'s own
 * `CableEnd`), one hop short of the `Device` a tag actually sits on
 * (`document/tags.ts`'s `Taggable` kinds); this is that hop. A shelf
 * occupant or surface fixture carries no `deviceId` in today's view types,
 * so a Device-kind tag on one of those is not reached through this index —
 * a real gap, no worse than the group simply missing that one cable, never
 * a wrong one. */
function chassisDeviceIdIndex(view: ClosetView): Map<string, string> {
  const map = new Map<string, string>();
  for (const rack of view.racks ?? []) for (const c of rack.chassis) map.set(c.id, c.deviceId);
  for (const c of view.unplaced ?? []) map.set(c.id, c.deviceId);
  return map;
}

/** Every node id the "device" picker offers — a rack chassis, an unplaced
 * chassis, a shelf occupant (a passive too) and a surface/board fixture,
 * each keyed by whichever id its own port end carries as `CableEnd.chassisId`
 * (`document/view.ts`'s own generic field name for "whatever owns this
 * port"), named by hostname/label, falling back to model. */
export function deviceNameIndex(view: ClosetView): Map<string, string> {
  const map = new Map<string, string>();
  function note(id: string, primary: string, model: string | null): void {
    const trimmed = primary.trim();
    const name = trimmed.length > 0 ? trimmed : (model ?? '').trim();
    if (name.length > 0) map.set(id, name);
  }
  for (const rack of view.racks ?? []) {
    for (const c of rack.chassis) note(c.id, c.hostname, c.model);
    for (const shelf of rack.shelves ?? []) for (const occ of shelf.occupants) note(occ.id, occ.label, occ.model);
  }
  function walkFixtures(fixtures: readonly FixtureView[]): void {
    for (const f of fixtures) {
      note(f.id, f.label, f.model);
      if (f.fixtures.length > 0) walkFixtures(f.fixtures);
    }
  }
  for (const surface of view.surfaces ?? []) walkFixtures(surface.fixtures);
  for (const c of view.unplaced ?? []) note(c.id, c.hostname, c.model);
  return map;
}

/** Cables with an end on any object in `objectIds` — the cable itself, a
 * port, or (through `deviceIdOf`) the device that port sits on. Decision 5's
 * tag rule: "the cables that carry the tag, and the cables with an end on a
 * port or a device that carries it." One pass over `view.cables`, the
 * membership SET already read once off the tag index — never a lookup per
 * cable back into `document/tags.ts`. */
function cablesForObjectIds(view: ClosetView, objectIds: ReadonlySet<string>, deviceIdOf: ReadonlyMap<string, string>): Set<string> {
  const out = new Set<string>();
  for (const c of view.cables ?? []) {
    if (objectIds.has(c.id)) {
      out.add(c.id);
      continue;
    }
    for (const e of realEnds(c)) {
      if (objectIds.has(e.portId) || objectIds.has(e.chassisId)) {
        out.add(c.id);
        break;
      }
      const deviceId = deviceIdOf.get(e.chassisId);
      if (deviceId != null && objectIds.has(deviceId)) {
        out.add(c.id);
        break;
      }
    }
  }
  return out;
}

/** `null` when `ref` no longer resolves — the row/tag/device it named is
 * gone (decision 5: "A reference that no longer resolves drops off the
 * list"). A type group always resolves; it names a kind, not a live thing. */
export function resolveCableGroup(doc: Document, view: ClosetView, ref: CableGroupRef): ResolvedCableGroup | null {
  if (ref.kind === 'vlan') {
    const row = deriveNetworks(doc).vlanRows.find((r) => r.key === ref.key);
    if (!row) return null;
    const cableIds = new Set(cablesCarryingVlan(doc, row.vlanNodeIds));
    const dashedCableIds = new Set(trunkCableIdsForVlan(doc, row.vlanNodeIds));
    const name = row.name ? `VLAN ${row.vlanId} · ${row.name}` : `VLAN ${row.vlanId}`;
    return { ref, kindLabel: 'VLAN', name, cableIds, dashedCableIds };
  }
  if (ref.kind === 'tag') {
    const group = tagGroupByFold(doc, ref.fold);
    if (!group) return null;
    const objectIds = objectsInTagGroupByFold(doc, ref.fold);
    const cableIds = cablesForObjectIds(view, objectIds, chassisDeviceIdIndex(view));
    return { ref, kindLabel: 'TAG', name: group.name, cableIds };
  }
  if (ref.kind === 'type') {
    const cableIds = new Set((view.cables ?? []).filter((c) => cableTypeGroupOf(c.media) === ref.type).map((c) => c.id));
    return { ref, kindLabel: 'TYPE', name: CABLE_TYPE_GROUP_LABEL[ref.type], cableIds };
  }
  const name = deviceNameIndex(view).get(ref.nodeId);
  if (name == null) return null;
  const cableIds = new Set((view.cables ?? []).filter((c) => realEnds(c).some((e) => e.chassisId === ref.nodeId)).map((c) => c.id));
  return { ref, kindLabel: 'DEVICE', name, cableIds };
}

/** Every group the "+ Add a group…" picker offers — one row per VLAN row,
 * per tag, per type and per named device, whether or not it is already on
 * the stored list (the caller filters those out). */
export function availableCableGroupRefs(doc: Document, view: ClosetView): CableGroupRef[] {
  const refs: CableGroupRef[] = [];
  for (const row of deriveNetworks(doc).vlanRows) refs.push({ kind: 'vlan', key: row.key });
  for (const tag of listTags(doc)) refs.push({ kind: 'tag', fold: foldTagName(tag.name) });
  for (const type of CABLE_TYPE_GROUPS) refs.push({ kind: 'type', type });
  for (const nodeId of deviceNameIndex(view).keys()) refs.push({ kind: 'device', nodeId });
  return refs;
}

/** Every stored group, resolved; a reference that no longer resolves is
 * left out of `rows` and named in `droppedRefKeys` instead — the caller may
 * choose to persist the state with those dropped (never required: the next
 * resolution simply drops them again). */
export function resolveStoredGroups(
  doc: Document,
  view: ClosetView,
  state: StoredCableGroupsState,
): { rows: Array<{ stored: StoredCableGroup; resolved: ResolvedCableGroup }>; droppedRefKeys: string[] } {
  const rows: Array<{ stored: StoredCableGroup; resolved: ResolvedCableGroup }> = [];
  const droppedRefKeys: string[] = [];
  for (const stored of state.groups) {
    const resolved = resolveCableGroup(doc, view, stored.ref);
    if (resolved) rows.push({ stored, resolved });
    else droppedRefKeys.push(cableGroupRefKey(stored.ref));
  }
  return { rows, droppedRefKeys };
}

// ---------------------------------------------------------------------------
// The draw rule — decision 4.

export interface CableDrawResult {
  drawnIds: ReadonlySet<string>;
  dashedIds: ReadonlySet<string>;
}

/** "A cable hidden one at a time never draws. Otherwise: with None on,
 * nothing draws; with any group ticked, the cables of every ticked group
 * draw; with none ticked, every cable draws." `dashedIds` is every cable a
 * ticked VLAN group marks dashed MINUS every cable any ticked group (that
 * one included) also carries untagged — "another ticked group that includes
 * it untagged makes it solid." */
export function computeCableDraw(
  cableIds: readonly string[],
  hiddenCableIds: ReadonlySet<string>,
  none: boolean,
  tickedGroups: readonly Pick<ResolvedCableGroup, 'cableIds' | 'dashedCableIds'>[],
): CableDrawResult {
  const drawnIds = new Set<string>();
  const dashedCandidates = new Set<string>();
  const solidForced = new Set<string>();
  if (!none) {
    if (tickedGroups.length === 0) {
      for (const id of cableIds) if (!hiddenCableIds.has(id)) drawnIds.add(id);
    } else {
      for (const group of tickedGroups) {
        for (const id of group.cableIds) {
          if (hiddenCableIds.has(id)) continue;
          drawnIds.add(id);
          if (group.dashedCableIds?.has(id)) dashedCandidates.add(id);
          else solidForced.add(id);
        }
      }
    }
  }
  const dashedIds = new Set<string>();
  for (const id of dashedCandidates) if (!solidForced.has(id)) dashedIds.add(id);
  return { drawnIds, dashedIds };
}

/** Decision 4 — "All is lit when no group is ticked and None is off." */
export function isAllShortcutLit(state: StoredCableGroupsState): boolean {
  return !state.none && state.groups.every((g) => !g.on);
}

/** "None is lit when it is on." */
export function isNoneShortcutLit(state: StoredCableGroupsState): boolean {
  return state.none;
}

/** Decision 2 — "While anything is filtered, [the lens] reads 'Cables · 5 of
 * 38.'" True whenever the drawn set could differ from every cable: None is
 * on, some group is ticked, or a cable is hidden one at a time. */
export function isCableGroupsFiltered(state: StoredCableGroupsState): boolean {
  return state.none || state.groups.some((g) => g.on) || state.hiddenCableIds.length > 0;
}

// ---------------------------------------------------------------------------
// State transitions — every one pure, so the popover and its test share the
// same rule. `refKey` throughout is `cableGroupRefKey`'s own output.

/** The "All" shortcut — decision 4: "both untick every group." */
export function withAllShortcut(state: StoredCableGroupsState): StoredCableGroupsState {
  return { ...state, none: false, groups: state.groups.map((g) => (g.on ? { ...g, on: false } : g)) };
}

/** The "None" shortcut — same untick, plus None itself goes on. */
export function withNoneShortcut(state: StoredCableGroupsState): StoredCableGroupsState {
  return { ...state, none: true, groups: state.groups.map((g) => (g.on ? { ...g, on: false } : g)) };
}

/** Ticking a group turns None off (decision 4); unticking leaves it as it
 * was. */
export function withGroupTicked(state: StoredCableGroupsState, refKey: string, on: boolean): StoredCableGroupsState {
  return {
    ...state,
    none: on ? false : state.none,
    groups: state.groups.map((g) => (cableGroupRefKey(g.ref) === refKey ? { ...g, on } : g)),
  };
}

/** "+ Add a group…" — added unticked; a reference already on the list is
 * left exactly as it was rather than duplicated. */
export function withGroupAdded(state: StoredCableGroupsState, ref: CableGroupRef): StoredCableGroupsState {
  const key = cableGroupRefKey(ref);
  if (state.groups.some((g) => cableGroupRefKey(g.ref) === key)) return state;
  return { ...state, groups: [...state.groups, { ref, on: false }] };
}

/** The × on hover. */
export function withGroupRemoved(state: StoredCableGroupsState, refKey: string): StoredCableGroupsState {
  return { ...state, groups: state.groups.filter((g) => cableGroupRefKey(g.ref) !== refKey) };
}

/** Decision 6 — "Hide this cable." */
export function withCableHidden(state: StoredCableGroupsState, cableId: string): StoredCableGroupsState {
  if (state.hiddenCableIds.includes(cableId)) return state;
  return { ...state, hiddenCableIds: [...state.hiddenCableIds, cableId] };
}

/** "Show this cable" — the reverse, one cable. */
export function withCableShown(state: StoredCableGroupsState, cableId: string): StoredCableGroupsState {
  if (!state.hiddenCableIds.includes(cableId)) return state;
  return { ...state, hiddenCableIds: state.hiddenCableIds.filter((id) => id !== cableId) };
}

/** "show" on the chip or the list's own row — brings every hidden cable
 * back at once. */
export function withAllCablesShown(state: StoredCableGroupsState): StoredCableGroupsState {
  return state.hiddenCableIds.length === 0 ? state : { ...state, hiddenCableIds: [] };
}
