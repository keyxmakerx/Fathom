/**
 * The Cables list. Replaces the old single "all · copper · fibre · power ·
 * none" view control with several named groups, any number on at once, each
 * a VLAN row, a tag, a media type or a device.
 *
 * Pure: no DOM, no React. Three layers, in the order below —
 *
 *  1. Storage (`load`/`saveCableGroupsState`, `localStorage`, wrapped in
 *     try/catch) — one JSON object per design, never the document, never
 *     undo.
 *  2. Resolution (`resolveCableGroup`) — turns a stored REFERENCE (a VLAN's
 *     number and member node ids, a tag's node id, a type name, a device's
 *     node id — never a name, which can change) into the cable ids it
 *     currently means, or `null` when the reference no longer resolves (the
 *     row/tag/device is gone) — the caller drops that row rather than show
 *     a broken one. Every result is scoped to THIS closet: a cable with no
 *     end on a port this closet draws is never counted, even when the same
 *     VLAN or tag also reaches another premises. Resolution is cached by
 *     document and view reference, so ticking, unticking, All, None, hide
 *     and show never re-resolve anything already asked for.
 *  3. The draw rule (`computeCableDraw`) — hidden-one-at-a-time cables never
 *     draw; otherwise None hides everything, a ticked group's cables draw,
 *     no ticked group draws every cable, and All/None are shortcuts that
 *     untick every group. Only a ticked VLAN group can dash or solidify a
 *     cable; a type, tag or device group only ever adds to what draws.
 */

import { kebab, type Document } from '../../document/model';
import { cablesForVlan, deriveNetworks } from '../../document/networks-derive';
import { listTags, objectsInTagGroupByNodeId, tagGroupByNodeId } from '../../document/tags';
import type { FixtureView } from '../../document/view';
import type { CableView, ClosetView } from './contract';

// ---------------------------------------------------------------------------
// Type groups.

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
// References — stable across a rename or a VLAN row split/join.

export type CableGroupRef =
  | { kind: 'vlan'; vlanId: number; nodeIds: readonly string[] }
  | { kind: 'tag'; nodeId: string }
  | { kind: 'type'; type: CableTypeGroup }
  | { kind: 'device'; nodeId: string };

/** A vlan's key also carries its member node ids, sorted — two distinct
 * VLAN rows sharing one numeric id (`networks-derive.ts`'s own `VlanRow.key`
 * shape) must never collide into one stored group. */
export function cableGroupRefKey(ref: CableGroupRef): string {
  switch (ref.kind) {
    case 'vlan':
      return `vlan:${ref.vlanId}:${[...ref.nodeIds].sort().join(',')}`;
    case 'tag':
      return `tag:${ref.nodeId}`;
    case 'type':
      return `type:${ref.type}`;
    case 'device':
      return `device:${ref.nodeId}`;
  }
}

// ---------------------------------------------------------------------------
// Stored state — localStorage, one key per design.

export interface StoredCableGroup {
  ref: CableGroupRef;
  on: boolean;
}

export interface StoredCableGroupsState {
  groups: StoredCableGroup[];
  none: boolean;
  /** Hidden one cable at a time, never a group; kept alongside the groups
   * because both live under the one per-design key. Design-wide — the same
   * list a cable dropped from any closet joins. */
  hiddenCableIds: string[];
}

/** Exported so a caller can recognise this design's own key in a `storage`
 * event (cross-tab sync) without duplicating the format. */
export function cableGroupsStorageKey(designId: string): string {
  return `fathom.cables.${designId}`;
}
const storageKey = cableGroupsStorageKey;

function isCableGroupRef(v: unknown): v is CableGroupRef {
  if (v == null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r.kind === 'vlan') {
    return typeof r.vlanId === 'number' && Array.isArray(r.nodeIds) && r.nodeIds.every((id) => typeof id === 'string');
  }
  if (r.kind === 'tag') return typeof r.nodeId === 'string';
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
 * falls back to a migrated choice or the plain default
 * (`migratedOrDefaultCableGroupsState`, below). `localStorage` wrapped in
 * try/catch: private browsing, a disabled storage API or a full quota all
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

/** Best-effort only: a save that fails leaves whatever was already stored
 * rather than throwing out of a click handler. Never a document fact — this
 * key is never sent to the server and never enters undo. */
export function saveCableGroupsState(designId: string, state: StoredCableGroupsState): void {
  try {
    localStorage.setItem(storageKey(designId), JSON.stringify(state));
  } catch {
    // best effort only
  }
}

// ---------------------------------------------------------------------------
// Closet scoping — a group's cables, the default list and "N of M" all
// count only what this closet actually draws, never the whole design.

/** Every port id reachable from this closet's own drawing — a rack's
 * chassis and their PSU inlets, a shelf's occupants, a surface's fixtures
 * and their own nested board fixtures, and every unplaced chassis this view
 * carries. The same set the drawing would draw with no filter at all. */
function closetPortIdsUncached(view: ClosetView): Set<string> {
  const ids = new Set<string>();
  function noteChassisLike(ports: PortLike[], psuInlets?: PortLike[]): void {
    for (const p of ports) ids.add(p.id);
    for (const p of psuInlets ?? []) ids.add(p.id);
  }
  interface PortLike {
    id: string;
  }
  for (const rack of view.racks ?? []) {
    for (const c of rack.chassis) noteChassisLike(c.ports, c.psuInlets);
    for (const shelf of rack.shelves ?? []) for (const occ of shelf.occupants) noteChassisLike(occ.ports);
  }
  function walkFixtures(fixtures: readonly FixtureView[]): void {
    for (const f of fixtures) {
      noteChassisLike(f.ports, f.psuInlets);
      if (f.fixtures.length > 0) walkFixtures(f.fixtures);
    }
  }
  for (const surface of view.surfaces ?? []) walkFixtures(surface.fixtures);
  for (const c of view.unplaced ?? []) noteChassisLike(c.ports, c.psuInlets);
  return ids;
}

const closetCableCache = new WeakMap<ClosetView, ReadonlySet<string>>();

/** Every cable id with a real end on a port `closetPortIdsUncached` names —
 * cached by view reference, so a render asking several groups' own
 * membership in one pass pays this walk once, not once per group. The
 * caller's own "N of M" and the drawing's own "no group ticked" cable list
 * both read this directly. */
export function closetCableIdSet(view: ClosetView): ReadonlySet<string> {
  const cached = closetCableCache.get(view);
  if (cached) return cached;
  const portIds = closetPortIdsUncached(view);
  const cableIds = new Set<string>();
  for (const c of view.cables ?? []) {
    if (realEnds(c).some((e) => portIds.has(e.portId))) cableIds.add(c.id);
  }
  closetCableCache.set(view, cableIds);
  return cableIds;
}

/** The chip's own count — hidden cables that are actually in THIS closet;
 * "show" (`withAllCablesShown`) still clears every hidden cable in the
 * design, not only this closet's own. */
export function closetHiddenCableCount(view: ClosetView, hiddenCableIds: readonly string[]): number {
  const closetIds = closetCableIdSet(view);
  let count = 0;
  for (const id of hiddenCableIds) if (closetIds.has(id)) count += 1;
  return count;
}

// ---------------------------------------------------------------------------
// Defaults and the one-time migration.

/** With nothing stored for a design, the list starts with the types that
 * occur in this closet, all unticked. */
export function defaultCableGroupsState(view: ClosetView): StoredCableGroupsState {
  const closetIds = closetCableIdSet(view);
  const present = new Set((view.cables ?? []).filter((c) => closetIds.has(c.id)).map((c) => cableTypeGroupOf(c.media)));
  const groups: StoredCableGroup[] = CABLE_TYPE_GROUPS.filter((type) => present.has(type)).map((type) => ({
    ref: { kind: 'type', type },
    on: false,
  }));
  return { groups, none: false, hiddenCableIds: [] };
}

const OLD_VISIBILITY_KEY = 'fathom.drawing.cableVisibility';
const OLD_VISIBILITY_VALUES = ['all', 'copper', 'fibre', 'power', 'none'] as const;
type OldVisibility = (typeof OLD_VISIBILITY_VALUES)[number];

/** Reads and removes the old view control's choice — once for the whole
 * browser, not once per design: a design opened after the first read finds
 * the key already gone and starts at the plain default. */
function takeOldVisibilityOnce(): OldVisibility | null {
  try {
    const raw = localStorage.getItem(OLD_VISIBILITY_KEY);
    localStorage.removeItem(OLD_VISIBILITY_KEY);
    return raw != null && (OLD_VISIBILITY_VALUES as readonly string[]).includes(raw) ? (raw as OldVisibility) : null;
  } catch {
    return null;
  }
}

/** The one-time migration, run when nothing is stored yet for a design: a
 * stored old choice of copper, fibre or power becomes that type group,
 * ticked; none becomes None; all (or nothing stored at all, or the read
 * itself failing) is the plain default, untouched. The caller persists the
 * result so the next open of this design reads its own stored state. */
export function migratedOrDefaultCableGroupsState(view: ClosetView): StoredCableGroupsState {
  const base = defaultCableGroupsState(view);
  const old = takeOldVisibilityOnce();
  if (old === null || old === 'all') return base;
  if (old === 'none') return { ...base, none: true };
  const ref: CableGroupRef = { kind: 'type', type: old };
  const key = cableGroupRefKey(ref);
  const alreadyListed = base.groups.some((g) => cableGroupRefKey(g.ref) === key);
  const groups = alreadyListed
    ? base.groups.map((g) => (cableGroupRefKey(g.ref) === key ? { ...g, on: true } : g))
    : [...base.groups, { ref, on: true }];
  return { groups, none: false, hiddenCableIds: [] };
}

// ---------------------------------------------------------------------------
// Resolution.

export type CableGroupKindLabel = 'VLAN' | 'TAG' | 'TYPE' | 'DEVICE';

export interface ResolvedCableGroup {
  ref: CableGroupRef;
  kindLabel: CableGroupKindLabel;
  name: string;
  cableIds: ReadonlySet<string>;
  /** VLAN only — a cable that carries the VLAN tagged draws dashed while
   * the group is on: a trunk member at either end of its path, through
   * passive hops. A subset of `cableIds`. */
  dashedCableIds?: ReadonlySet<string>;
}

function realEnds(cable: CableView): Array<{ portId: string; chassisId: string }> {
  return cable.ends.filter((e): e is { portId: string; chassisId: string; rackId: string | null } => 'portId' in e);
}

const HAS_CHASSIS_PREFIX = `${kebab('HasChassis')}:`;

const chassisDeviceCache = new WeakMap<Document, ReadonlyMap<string, string>>();

/** Every live `Chassis` node's own `Device` id, read straight off `HasChassis`
 * once per document — this is what a rack chassis, a shelf occupant and a
 * surface or board fixture all carry regardless of how each is placed, so a
 * Device-kind tag reaches its device's cables the same way wherever the
 * device sits. Cached by document reference. */
function chassisDeviceIdIndex(doc: Document): ReadonlyMap<string, string> {
  const cached = chassisDeviceCache.get(doc);
  if (cached) return cached;
  const map = new Map<string, string>();
  for (const e of doc.edges) {
    if (e.absentSince !== undefined || !e.id.startsWith(HAS_CHASSIS_PREFIX)) continue;
    map.set(e.to, e.from);
  }
  chassisDeviceCache.set(doc, map);
  return map;
}

const deviceNameCache = new WeakMap<ClosetView, ReadonlyMap<string, string>>();

/** Every node id the "device" picker offers — a rack chassis, an unplaced
 * chassis, a shelf occupant (a passive too) and a surface/board fixture,
 * each keyed by whichever id its own port end carries as `CableEnd.chassisId`
 * (`document/view.ts`'s own generic field name for "whatever owns this
 * port"), named by hostname/label, falling back to model. Cached by view
 * reference — built once per view, not once per device it is asked about. */
export function deviceNameIndex(view: ClosetView): ReadonlyMap<string, string> {
  const cached = deviceNameCache.get(view);
  if (cached) return cached;
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
  deviceNameCache.set(view, map);
  return map;
}

/** Cables with an end on any object in `objectIds` — the cable itself, a
 * port, or (through `deviceIdOf`) the device that port sits on. One pass
 * over `view.cables`, the membership SET already read once off the tag
 * index — never a lookup per cable back into `document/tags.ts`. */
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

function intersect(ids: ReadonlySet<string>, allow: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) if (allow.has(id)) out.add(id);
  return out;
}

/** `null` when `ref` no longer resolves — the row/tag/device it named is
 * gone. A type group always resolves; it names a kind, not a live thing.
 * Every result is intersected with this closet's own cables
 * (`closetCableIdSet`) before it is returned. */
function resolveCableGroupUncached(doc: Document, view: ClosetView, ref: CableGroupRef): ResolvedCableGroup | null {
  const closetIds = closetCableIdSet(view);
  if (ref.kind === 'vlan') {
    const rows = deriveNetworks(doc).vlanRows;
    const bySharedNode = rows.find((r) => r.vlanNodeIds.some((id) => ref.nodeIds.includes(id)));
    const row = bySharedNode ?? (rows.filter((r) => r.vlanId === ref.vlanId).length === 1 ? rows.find((r) => r.vlanId === ref.vlanId) : undefined);
    if (!row) return null;
    const { cableIds: rawCableIds, trunkCableIds: rawTrunkIds } = cablesForVlan(doc, row.vlanNodeIds);
    const cableIds = intersect(new Set(rawCableIds), closetIds);
    const dashedCableIds = intersect(new Set(rawTrunkIds), closetIds);
    const name = row.name ? `VLAN ${row.vlanId} · ${row.name}` : `VLAN ${row.vlanId}`;
    return { ref, kindLabel: 'VLAN', name, cableIds, dashedCableIds };
  }
  if (ref.kind === 'tag') {
    const group = tagGroupByNodeId(doc, ref.nodeId);
    if (!group) return null;
    const objectIds = objectsInTagGroupByNodeId(doc, ref.nodeId);
    const cableIds = intersect(cablesForObjectIds(view, objectIds, chassisDeviceIdIndex(doc)), closetIds);
    return { ref, kindLabel: 'TAG', name: group.name, cableIds };
  }
  if (ref.kind === 'type') {
    const cableIds = new Set(
      (view.cables ?? []).filter((c) => closetIds.has(c.id) && cableTypeGroupOf(c.media) === ref.type).map((c) => c.id),
    );
    return { ref, kindLabel: 'TYPE', name: CABLE_TYPE_GROUP_LABEL[ref.type], cableIds };
  }
  const name = deviceNameIndex(view).get(ref.nodeId);
  if (name == null) return null;
  const cableIds = new Set(
    (view.cables ?? []).filter((c) => closetIds.has(c.id) && realEnds(c).some((e) => e.chassisId === ref.nodeId)).map((c) => c.id),
  );
  return { ref, kindLabel: 'DEVICE', name, cableIds };
}

const resolveCache = new WeakMap<Document, WeakMap<ClosetView, Map<string, ResolvedCableGroup | null>>>();

/** `resolveCableGroupUncached`, memoised by document and view reference —
 * ticking, unticking, All, None, hide and show all hand back the same
 * document and view, so every one of those hits this cache rather than
 * re-walking the graph. */
export function resolveCableGroup(doc: Document, view: ClosetView, ref: CableGroupRef): ResolvedCableGroup | null {
  let byView = resolveCache.get(doc);
  if (!byView) {
    byView = new WeakMap();
    resolveCache.set(doc, byView);
  }
  let byKey = byView.get(view);
  if (!byKey) {
    byKey = new Map();
    byView.set(view, byKey);
  }
  const key = cableGroupRefKey(ref);
  if (byKey.has(key)) return byKey.get(key)!;
  const resolved = resolveCableGroupUncached(doc, view, ref);
  byKey.set(key, resolved);
  return resolved;
}

export interface CableGroupCandidate {
  ref: CableGroupRef;
  kindLabel: CableGroupKindLabel;
  name: string;
}

/** Every group the "+ Add a group…" picker offers — one row per VLAN row,
 * per tag, per type and per named device, whether or not it is already on
 * the stored list (the caller filters those out) — with a NAME cheap enough
 * to read without resolving membership at all: `resolveCableGroup` is what
 * actually walks the graph for a cable count, and the picker only pays that
 * for the rows it ends up showing after its own text filter, never for
 * every candidate up front. */
export function availableCableGroupCandidates(doc: Document, view: ClosetView): CableGroupCandidate[] {
  const out: CableGroupCandidate[] = [];
  for (const row of deriveNetworks(doc).vlanRows) {
    const name = row.name ? `VLAN ${row.vlanId} · ${row.name}` : `VLAN ${row.vlanId}`;
    out.push({ ref: { kind: 'vlan', vlanId: row.vlanId, nodeIds: row.vlanNodeIds }, kindLabel: 'VLAN', name });
  }
  for (const tag of listTags(doc)) out.push({ ref: { kind: 'tag', nodeId: tag.id }, kindLabel: 'TAG', name: tag.name });
  for (const type of CABLE_TYPE_GROUPS) out.push({ ref: { kind: 'type', type }, kindLabel: 'TYPE', name: CABLE_TYPE_GROUP_LABEL[type] });
  for (const [nodeId, name] of deviceNameIndex(view)) out.push({ ref: { kind: 'device', nodeId }, kindLabel: 'DEVICE', name });
  return out;
}

/** Every stored group, resolved, plus the state a caller should persist:
 * unchanged (`=== state`) when every reference still resolves, otherwise a
 * fresh state with the unresolved ones removed — a group that stops
 * resolving is dropped from storage, not just from this one render. */
export function resolveStoredGroups(
  doc: Document,
  view: ClosetView,
  state: StoredCableGroupsState,
): { state: StoredCableGroupsState; rows: Array<{ stored: StoredCableGroup; resolved: ResolvedCableGroup }>; droppedRefKeys: string[] } {
  const rows: Array<{ stored: StoredCableGroup; resolved: ResolvedCableGroup }> = [];
  const droppedRefKeys: string[] = [];
  const keptGroups: StoredCableGroup[] = [];
  for (const stored of state.groups) {
    const resolved = resolveCableGroup(doc, view, stored.ref);
    if (resolved) {
      rows.push({ stored, resolved });
      keptGroups.push(stored);
    } else {
      droppedRefKeys.push(cableGroupRefKey(stored.ref));
    }
  }
  const nextState = droppedRefKeys.length === 0 ? state : { ...state, groups: keptGroups };
  return { state: nextState, rows, droppedRefKeys };
}

// ---------------------------------------------------------------------------
// The draw rule.

export interface CableDrawResult {
  drawnIds: ReadonlySet<string>;
  dashedIds: ReadonlySet<string>;
}

/** "A cable hidden one at a time never draws. Otherwise: with None on,
 * nothing draws; with any group ticked, the cables of every ticked group
 * draw; with none ticked, every cable draws." `dashedIds` is every cable a
 * ticked VLAN group marks dashed MINUS every cable another ticked VLAN
 * group also carries untagged — "another ticked VLAN group that carries it
 * untagged makes it solid." A type, tag or device group only ever adds
 * cables to what draws; it never dashes one and never solidifies one. */
export function computeCableDraw(
  cableIds: readonly string[],
  hiddenCableIds: ReadonlySet<string>,
  none: boolean,
  tickedGroups: readonly Pick<ResolvedCableGroup, 'ref' | 'cableIds' | 'dashedCableIds'>[],
): CableDrawResult {
  const drawnIds = new Set<string>();
  const dashedCandidates = new Set<string>();
  const solidForced = new Set<string>();
  if (!none) {
    if (tickedGroups.length === 0) {
      for (const id of cableIds) if (!hiddenCableIds.has(id)) drawnIds.add(id);
    } else {
      for (const group of tickedGroups) {
        const isVlan = group.ref.kind === 'vlan';
        for (const id of group.cableIds) {
          if (hiddenCableIds.has(id)) continue;
          drawnIds.add(id);
          if (!isVlan) continue;
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

/** All is lit when no group is ticked and None is off. */
export function isAllShortcutLit(state: StoredCableGroupsState): boolean {
  return !state.none && state.groups.every((g) => !g.on);
}

/** None is lit when it is on. */
export function isNoneShortcutLit(state: StoredCableGroupsState): boolean {
  return state.none;
}

/** True whenever the drawn set could differ from every cable: None is on,
 * some group is ticked, or a cable is hidden one at a time. The caller
 * passes the state AFTER `resolveStoredGroups` has dropped anything that no
 * longer resolves, so a vanished ticked group never leaves this stuck on. */
export function isCableGroupsFiltered(state: StoredCableGroupsState): boolean {
  return state.none || state.groups.some((g) => g.on) || state.hiddenCableIds.length > 0;
}

// ---------------------------------------------------------------------------
// State transitions — every one pure, so the popover and its test share the
// same rule. `refKey` throughout is `cableGroupRefKey`'s own output.

/** The "All" shortcut — both untick every group. */
export function withAllShortcut(state: StoredCableGroupsState): StoredCableGroupsState {
  return { ...state, none: false, groups: state.groups.map((g) => (g.on ? { ...g, on: false } : g)) };
}

/** The "None" shortcut — same untick, plus None itself goes on. */
export function withNoneShortcut(state: StoredCableGroupsState): StoredCableGroupsState {
  return { ...state, none: true, groups: state.groups.map((g) => (g.on ? { ...g, on: false } : g)) };
}

/** Ticking a group turns None off; unticking leaves it as it was. */
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

/** "Hide this cable." */
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
 * back at once, across the whole design, not only this closet. */
export function withAllCablesShown(state: StoredCableGroupsState): StoredCableGroupsState {
  return state.hiddenCableIds.length === 0 ? state : { ...state, hiddenCableIds: [] };
}

/** Drops a hidden id whose cable no longer exists anywhere in the design —
 * `existingCableIds` is every live `Cable` this document still holds
 * (`ClosetView.cables`, design-wide by its own header doc). Unchanged
 * (`=== state`) when nothing needed pruning, so the caller only saves when
 * this actually did something. */
export function withHiddenCablesPruned(state: StoredCableGroupsState, existingCableIds: ReadonlySet<string>): StoredCableGroupsState {
  const kept = state.hiddenCableIds.filter((id) => existingCableIds.has(id));
  return kept.length === state.hiddenCableIds.length ? state : { ...state, hiddenCableIds: kept };
}
