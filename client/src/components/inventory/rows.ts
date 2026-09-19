// The pure half of the Inventory place (ADR-0046 §8) — no React, no
// `Document` mutation, everything a `DeviceRow`/`GapRow`/column set is
// derived from a `ClosetView` (`document/view.ts`) or a raw `Document`
// (only for "last change," which needs `Document.provenance` — a
// `ClosetView` carries no field provenance). ADR-0046 §2: "Nothing in a list
// is typed" — every value here is read off the graph or the catalogue, never
// invented; `ABSENT` (`drawing/contract.ts`'s own dash) is what a missing
// fact draws as, in every column.

import { ABSENT, type Selection } from '../drawing/contract';
import type { Lens } from '../shell/lens';
import {
  edgesIn,
  edgesOut,
  findNode,
  parseNodeId,
  readChassisFields,
  readDeviceFields,
  type Document,
} from '../../document/model';
import type {
  CableView,
  ChassisView,
  ClosetView,
  FixtureView,
  InletView,
  OccupantView,
  Placement,
  PortView,
  RackView,
  ShelfView,
  SurfaceView,
} from '../../document/view';

export type { Lens };

// ---------------------------------------------------------------------------
// Where — ADR-0051 §1's `Placement`, read into the exact words the brief
// asks for: "rack and unit, shelf and slot, or surface and millimetres."

export interface WhereLabels {
  rackLabel?: string;
  shelfLabel?: string;
  surfaceLabel?: string;
}

/** Pure: one `Placement` (whatever `ChassisView.placement`/`OccupantView`'s
 * own synthesised one/`FixtureView`'s own synthesised one holds) to the text
 * the "where" column shows. A label callers do not supply falls back to the
 * raw id — still a real fact (never invented), just not the friendlier name
 * a `ClosetView` lookup would have given it. */
export function whereText(placement: Placement, labels: WhereLabels = {}): string {
  switch (placement.kind) {
    case 'rack':
      return `${labels.rackLabel ?? placement.rackId} · U${placement.positionU}`;
    case 'shelf':
      return `${labels.shelfLabel ?? placement.shelfId} · slot ${placement.slot}`;
    case 'surface':
      return placement.xMm != null && placement.yMm != null
        ? `${labels.surfaceLabel ?? placement.surfaceId} · ${placement.xMm}mm, ${placement.yMm}mm`
        : `${labels.surfaceLabel ?? placement.surfaceId} · ${ABSENT}`;
    case 'board':
      return placement.xMm != null && placement.yMm != null
        ? `${labels.surfaceLabel ?? placement.boardId} · ${placement.xMm}mm, ${placement.yMm}mm`
        : `${labels.surfaceLabel ?? placement.boardId} · ${ABSENT}`;
    case 'none':
    default:
      return ABSENT;
  }
}

// ---------------------------------------------------------------------------
// Last change — "the newest provenance assertedAt among the device's
// fields, as a date" (this session's brief item 3).

/** Every node id whose fields count as "the device's own" for the
 * last-change rule: the `Device` node, its `Chassis`, every port on its
 * faceplate, and every PSU inlet/supply it carries. A synthetic inlet id
 * (`InletView`'s own doc: `slot:<chassisId>:<slotName>` for an unfitted
 * hot-swap bay) is included too — `lastChangeMs` below simply finds no node
 * for it and skips it, the same as any id this document does not carry. */
export function deviceNodeIds(chassis: ChassisView): string[] {
  const ids = [chassis.deviceId, chassis.id, ...chassis.ports.map((p) => p.id), ...chassis.psuInlets.map((i) => i.id)];
  for (const inlet of chassis.psuInlets) {
    if (inlet.supplyId != null) ids.push(inlet.supplyId);
  }
  return ids;
}

/** The newest `ProvenanceRecord.assertedAt` among every field of every node
 * named in `nodeIds`, or `null` when none of them carry a field at all (a
 * device that is nothing but structure — no node this document holds
 * asserts a field on it, which does not happen for a real `Chassis`/`Device`
 * pair today, but this reads honestly rather than assuming one always
 * will). A node id this document does not have is silently skipped, the
 * same "absent, not an error" reading `findNode` callers elsewhere use. */
export function lastChangeMs(doc: Document, nodeIds: readonly string[]): number | null {
  const provById = new Map(doc.provenance.map((p) => [p.id, p]));
  let latest: number | null = null;
  for (const nodeId of nodeIds) {
    const node = findNode(doc, nodeId);
    if (!node) continue;
    for (const key of Object.keys(node.fields)) {
      const entry = node.fields[key];
      const rec = provById.get(entry.prov);
      if (rec != null && (latest === null || rec.assertedAt > latest)) latest = rec.assertedAt;
    }
  }
  return latest;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `assertedAt` (epoch ms) as "DD Mon HH:MM", the grid's own format
 * (`design/proposals/screens/Inventory.dc.html`'s "12 Sep 09:41") — UTC, not
 * the browser's own zone, so this is the same string in every test run and
 * every reader's browser rather than one that quietly depends on where it
 * is opened. */
export function formatLastChange(ms: number): string {
  const d = new Date(ms);
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = MONTHS[d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month} ${hh}:${mm}`;
}

// ---------------------------------------------------------------------------
// Ports and power.

/** "6 / 16," or `ABSENT` for a device with no ports at all (a PDU, an
 * unmodelled sketch device with none typed yet) — never "0 / 0." */
export function portsCabledOfTotal(ports: readonly PortView[]): string {
  if (ports.length === 0) return ABSENT;
  const cabled = ports.filter((p) => p.cable != null).length;
  return `${cabled} / ${ports.length}`;
}

/** UI-SPEC "Power" / ADR-0050 §4, read into the four words this session's
 * brief names: `fed` (every fitted inlet is cabled), `single-fed`
 * (`singleFed`), `one fitted` (`oneFitted`), or `ABSENT` — for a chassis
 * with no PSU slots at all, or the one shape those two flags do not cover
 * (a single fitted inlet that is not cabled): "absent" is what an
 * unresolved power state draws as, the same rule that already governs every
 * other column, rather than inventing a fifth word the brief did not ask
 * for. */
export function powerLabel(psuInlets: readonly InletView[], singleFed: boolean, oneFitted: boolean): string {
  if (psuInlets.length === 0) return ABSENT;
  if (singleFed) return 'single-fed';
  if (oneFitted) return 'one fitted';
  const fitted = psuInlets.filter((i) => i.fitted);
  if (fitted.length > 0 && fitted.every((i) => i.cable != null)) return 'fed';
  return ABSENT;
}

/** The same rule as `powerLabel`, for a shelf `OccupantView` — which, per
 * `document/view.ts`'s own doc, carries no separate `psuInlets`/`singleFed`/
 * `oneFitted` of its own; a C14 port is simply one more entry in
 * `occupant.ports`. Every such port is treated as a fixed inlet (always
 * "fitted" — the same convention `InletView`'s own fixed-slot reading
 * uses), so "one fitted" (which names an EMPTY hot-swap bay) can never
 * apply here — there is no way for this view to represent one. */
export function occupantPowerLabel(ports: readonly PortView[]): string {
  const inlets = ports.filter((p) => p.connector === 'c14');
  if (inlets.length === 0) return ABSENT;
  const fed = inlets.filter((p) => p.cable != null).length;
  if (inlets.length >= 2 && fed === 1) return 'single-fed';
  if (fed === inlets.length) return 'fed';
  return ABSENT;
}

/** The Cables lens's own column: cable counts by kind, e.g. "copper 4 ·
 * fibre 2." `ABSENT` when the device carries no cable at all. Counts
 * distinct cables, not port ends (a cable with both ends on the same
 * device would otherwise count twice for one physical lead). */
export function cablesByKindText(ports: readonly PortView[], cables: readonly CableView[]): string {
  const kindById = new Map(cables.map((c) => [c.id, c.kind]));
  const seen = new Set<string>();
  const counts: Record<CableView['kind'], number> = { copper: 0, fibre: 0, power: 0 };
  for (const port of ports) {
    if (port.cable == null || seen.has(port.cable.cableId)) continue;
    seen.add(port.cable.cableId);
    const kind = kindById.get(port.cable.cableId);
    if (kind) counts[kind] += 1;
  }
  const parts = (['copper', 'fibre', 'power'] as const).filter((k) => counts[k] > 0).map((k) => `${k} ${counts[k]}`);
  return parts.length > 0 ? parts.join(' · ') : ABSENT;
}

/** The Power lens's own per-slot detail: `"PSU0: fed"`, `"PSU0: not fed"`,
 * or `"PSU0: not fitted"` for an empty hot-swap bay, joined with " · ".
 * `ABSENT` for a device with no PSU slots. */
export function inletStatesText(psuInlets: readonly InletView[]): string {
  if (psuInlets.length === 0) return ABSENT;
  return psuInlets.map((i) => `${i.slot}: ${!i.fitted ? 'not fitted' : i.cable != null ? 'fed' : 'not fed'}`).join(' · ');
}

/** UI-SPEC "Owner" lens / CLAUDE.md rule 3 — the schema has no owner field
 * on `Device`/`Chassis` today (`schema/schema.yaml` carries no such field;
 * every `owner(X)` hit there is the identity-term keyword, not a field
 * named "owner"). A field that is not in `schema/` does not exist, so this
 * always reads `ABSENT` — kept as its own named function, rather than a
 * literal inlined at each call site, so the day the schema gains a real
 * field this is the one place that changes. */
export function ownerLabel(): string {
  return ABSENT;
}

/** The grid's own `firmware` base column — `schema/schema.yaml` has no
 * firmware field on `Device`/`Chassis` either (ADR-0045's firmware staging
 * lives on the server, per `docs/UI-SPEC.md`'s Screens table: "lives inside
 * inventory, per model" — not a document field this client reads). Same
 * rule and the same reason as `ownerLabel` above: absent until the schema
 * says otherwise. */
export function firmwareLabel(): string {
  return ABSENT;
}

// ---------------------------------------------------------------------------
// Columns per lens (ADR-0047 §1: "in Inventory it changes which columns
// show").

export type ColumnKey = 'name' | 'model' | 'where' | 'ports' | 'firmware' | 'power' | 'lastChange' | 'cablesByKind' | 'inletStates' | 'owner';

export const BASE_COLUMNS: readonly ColumnKey[] = ['name', 'model', 'where', 'ports', 'firmware', 'power', 'lastChange'];

export const COLUMN_LABEL: Record<ColumnKey, string> = {
  name: 'name',
  model: 'model',
  where: 'where',
  ports: 'ports',
  firmware: 'firmware',
  power: 'power',
  lastChange: 'last change',
  cablesByKind: 'cables',
  inletStates: 'inlets',
  owner: 'owner',
};

/** Pure: the device grid's own column set for the active lens. Links and
 * Routing show the base seven; Cables replaces `ports` with `cablesByKind`;
 * Power replaces `power` with `inletStates`; Owner replaces `power` with
 * `owner` (ADR-0047 §1's "one at a time" — a lens changes marks and
 * columns, never adds a whole second set on top of the base). */
export function columnsForLens(lens: Lens): readonly ColumnKey[] {
  if (lens === 'cables') return ['name', 'model', 'where', 'cablesByKind', 'firmware', 'power', 'lastChange'];
  if (lens === 'power') return ['name', 'model', 'where', 'ports', 'firmware', 'inletStates', 'lastChange'];
  if (lens === 'owner') return ['name', 'model', 'where', 'ports', 'firmware', 'owner', 'lastChange'];
  return BASE_COLUMNS;
}

// ---------------------------------------------------------------------------
// Device rows and grouping (this session's brief item 3).

export interface DeviceRow {
  /** The exact `Selection` a click on this row raises — `EditorFor`'s own
   * union (`drawing/contract.ts`), so opening the row's page is opening the
   * same selection the drawing would make. */
  selection: Selection;
  name: string;
  model: string;
  where: string;
  ports: string;
  firmware: string;
  power: string;
  cablesByKind: string;
  inletStates: string;
  owner: string;
  lastChangeMs: number | null;
}

/** The row a rack-mounted `ChassisView` reduces to — exported so "the row
 * derivation" (this session's brief own list of pure parts to test) is
 * exercised directly, against a hand-built `ChassisView` literal, the same
 * "no `Document`, no React" shape `Editor.render.test.ts` already uses for
 * its own view literals. */
export function deviceRowFromChassis(chassis: ChassisView, doc: Document, rackLabel: string, cables: readonly CableView[]): DeviceRow {
  return {
    selection: { kind: 'chassis', id: chassis.id },
    name: chassis.hostname || ABSENT,
    model: chassis.model || ABSENT,
    where: whereText(chassis.placement, { rackLabel }),
    ports: portsCabledOfTotal(chassis.ports),
    firmware: firmwareLabel(),
    power: powerLabel(chassis.psuInlets, chassis.singleFed, chassis.oneFitted),
    cablesByKind: cablesByKindText(chassis.ports, cables),
    inletStates: inletStatesText(chassis.psuInlets),
    owner: ownerLabel(),
    lastChangeMs: lastChangeMs(doc, deviceNodeIds(chassis)),
  };
}

function occupantRow(occupant: OccupantView, doc: Document, rack: RackView, shelf: ShelfView, cables: readonly CableView[]): DeviceRow {
  const placement: Placement = { kind: 'shelf', shelfId: shelf.id, slot: occupant.slot };
  return {
    selection: { kind: 'occupant', id: occupant.id },
    name: occupant.label || ABSENT,
    model: occupant.model ?? ABSENT,
    where: whereText(placement, { shelfLabel: `${shelf.label || shelf.id} · ${rack.label}` }),
    ports: portsCabledOfTotal(occupant.ports),
    firmware: firmwareLabel(),
    power: occupantPowerLabel(occupant.ports),
    cablesByKind: cablesByKindText(occupant.ports, cables),
    inletStates: ABSENT, // no per-slot state to name — see `occupantPowerLabel`'s own doc
    owner: ownerLabel(),
    lastChangeMs: lastChangeMs(doc, [occupant.id, ...occupant.ports.map((p) => p.id)]),
  };
}

function fixtureChassisRow(fixture: FixtureView, doc: Document, surfaceLabel: string, cables: readonly CableView[]): DeviceRow {
  const placement: Placement = { kind: 'surface', surfaceId: fixture.id, xMm: fixture.xMm, yMm: fixture.yMm };
  return {
    selection: { kind: 'fixture', id: fixture.id },
    name: fixture.label || ABSENT,
    model: fixture.model ?? ABSENT,
    where: whereText(placement, { surfaceLabel }),
    ports: portsCabledOfTotal(fixture.ports),
    firmware: firmwareLabel(),
    power: powerLabel(fixture.psuInlets, fittedTwoPlusExactlyOneFed(fixture.psuInlets), fittedTwoPlusSomeEmpty(fixture.psuInlets)),
    cablesByKind: cablesByKindText(fixture.ports, cables),
    inletStates: inletStatesText(fixture.psuInlets),
    owner: ownerLabel(),
    lastChangeMs: lastChangeMs(doc, [fixture.id, ...fixture.ports.map((p) => p.id), ...fixture.psuInlets.map((i) => i.id)]),
  };
}

/** `ChassisView.singleFed`'s own rule (ADR-0050 §4), replicated for a
 * `FixtureView` — which carries the same `psuInlets` shape but no
 * pre-computed flag of its own. */
function fittedTwoPlusExactlyOneFed(psuInlets: readonly InletView[]): boolean {
  const fitted = psuInlets.filter((i) => i.fitted);
  return fitted.length >= 2 && fitted.filter((i) => i.cable != null).length === 1;
}

/** `ChassisView.oneFitted`'s own rule, replicated for the same reason. */
function fittedTwoPlusSomeEmpty(psuInlets: readonly InletView[]): boolean {
  return psuInlets.length >= 2 && psuInlets.some((i) => !i.fitted);
}

function collectFixtureChassisRows(
  fixtures: readonly FixtureView[],
  doc: Document,
  surfaceLabel: string,
  cables: readonly CableView[],
  out: DeviceRow[],
): void {
  for (const fixture of fixtures) {
    if (fixture.kind === 'chassis') out.push(fixtureChassisRow(fixture, doc, surfaceLabel, cables));
    collectFixtureChassisRows(fixture.fixtures, doc, surfaceLabel, cables, out);
  }
}

export interface DeviceRowGroup {
  label: string;
  rows: DeviceRow[];
}

/** `Chassis` nodes with no live `MountedIn`/`SitsOn`/`FixedTo` at all —
 * `viewOf` (`document/view.ts`) never surfaces one, since it only walks
 * those three edge kinds outward from a placed root, so this walks
 * `doc.nodes` directly. A minimal row: no catalogue faceplate is consulted
 * (this module never duplicates `document/view.ts`'s own faceplate-matching
 * — CLAUDE.md rule 1, one gate, and by the same principle one reducer), so
 * ports/power read off the raw `HasPort` count and cabling alone. */
function unplacedDeviceRows(doc: Document): DeviceRow[] {
  const rows: DeviceRow[] = [];
  for (const node of doc.nodes) {
    if (node.absentSince !== undefined) continue;
    if (parseNodeId(node.id).kind !== 'Chassis') continue;
    const placed =
      edgesOut(doc, node.id, 'MountedIn').length > 0 ||
      edgesOut(doc, node.id, 'SitsOn').length > 0 ||
      edgesOut(doc, node.id, 'FixedTo').length > 0;
    if (placed) continue;

    const hasChassis = edgesIn(doc, node.id, 'HasChassis')[0];
    const deviceNode = hasChassis ? findNode(doc, hasChassis.from) : undefined;
    const hostname = deviceNode ? (readDeviceFields(deviceNode).hostname ?? '') : '';
    const model = readChassisFields(node).model ?? '';
    const portIds = edgesOut(doc, node.id, 'HasPort').map((e) => e.to);
    const cabledCount = portIds.filter((portId) => edgesIn(doc, portId, 'Terminates').length > 0).length;

    rows.push({
      selection: { kind: 'chassis', id: node.id },
      name: hostname || ABSENT,
      model: model || ABSENT,
      where: ABSENT,
      ports: portIds.length > 0 ? `${cabledCount} / ${portIds.length}` : ABSENT,
      firmware: firmwareLabel(),
      power: ABSENT,
      cablesByKind: ABSENT,
      inletStates: ABSENT,
      owner: ownerLabel(),
      lastChangeMs: lastChangeMs(doc, [node.id, ...(hasChassis ? [hasChassis.from] : []), ...portIds]),
    });
  }
  return rows;
}

/** Rows grouped "per rack, then shelves, then surfaces, then unplaced"
 * (this session's brief item 3), each group in the same order `view.rows`/
 * `view.surfaces` already give — never re-sorted here, so a rack row's own
 * row/bay ordering (`document/view.ts`'s `rowsOf`) is the grouping order
 * too. Only `kind: 'chassis'` occupants/fixtures are "Devices" — a passive
 * occupant or fixture (a splitter, an outlet block) belongs to a different
 * kind, not this grid. */
export function groupDeviceRows(view: ClosetView, doc: Document): DeviceRowGroup[] {
  const groups: DeviceRowGroup[] = [];

  for (const row of view.rows) {
    for (const rack of row.racks) {
      if (rack.chassis.length === 0) continue;
      groups.push({
        label: `${rack.label} · ${rack.heightU}U`,
        rows: rack.chassis.map((c) => deviceRowFromChassis(c, doc, rack.label, view.cables)),
      });
    }
  }

  for (const row of view.rows) {
    for (const rack of row.racks) {
      for (const shelf of rack.shelves) {
        const chassisOccupants = shelf.occupants.filter((o) => o.kind === 'chassis');
        if (chassisOccupants.length === 0) continue;
        groups.push({
          label: `${rack.label} · ${shelf.label || shelf.id}`,
          rows: chassisOccupants.map((o) => occupantRow(o, doc, rack, shelf, view.cables)),
        });
      }
    }
  }

  for (const surface of view.surfaces) {
    const rows: DeviceRow[] = [];
    collectFixtureChassisRows(surface.fixtures, doc, surface.label || surface.id, view.cables, rows);
    if (rows.length > 0) groups.push({ label: surface.label || surface.id, rows });
  }

  const unplaced = unplacedDeviceRows(doc);
  if (unplaced.length > 0) groups.push({ label: 'Unplaced', rows: unplaced });

  return groups;
}

// ---------------------------------------------------------------------------
// Gaps — ADR-0046 §2: "Free space is inventory. A free run of rack units, a
// free port and an unfed power inlet are rows" — because, per UI-SPEC.md
// ("Inside a box"), "Absent is drawn as absent".

export interface GapRow {
  rackId: string;
  rackLabel: string;
  fromU: number;
  toU: number;
  sizeU: number;
}

/** Every rack's free runs (`RackView.freeRuns`, `document/view.ts`), one row
 * each — never merged or resorted, so a rack with two separate gaps shows
 * two rows in the same order the rack itself lists them (bottom-most or
 * top-most first, whichever `freeRuns` already produced). */
export function gapRows(view: ClosetView): GapRow[] {
  const rows: GapRow[] = [];
  for (const rack of view.racks) {
    for (const run of rack.freeRuns) {
      rows.push({ rackId: rack.id, rackLabel: rack.label, fromU: run.fromU, toU: run.toU, sizeU: run.toU - run.fromU + 1 });
    }
  }
  return rows;
}

export type { CableView, ChassisView, ClosetView, FixtureView, InletView, OccupantView, Placement, PortView, RackView, ShelfView, SurfaceView };
