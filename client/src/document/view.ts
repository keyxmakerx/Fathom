// The contract the drawing renders: a `Document` (plus the catalogue, for
// the facts the graph itself does not carry — a chassis's height in units
// and its faceplate layout) reduced to one premises's racks, each rack's
// mounted chassis and shelves, each shelf's occupants, each surface's
// fixtures, and every port's cabling.
//
// ADR-0051 §1 (schema 0.8) widens this from "racks of chassis" to "places":
// a shelf takes U and seats occupants by slot (`SitsOn`); a surface (wall,
// floor, desk, ceiling) holds fixtures at a measured or unmeasured position
// (`FixedTo`); a board is itself a fixture that carries its own nested
// fixtures. `Placement` below is the one union every placeable item (a
// Chassis or a PassiveNode) reduces to, read off whichever of `MountedIn` /
// `SitsOn` / `FixedTo` is live for it — `commands.ts`'s `movePlacement` is
// this module's write-side mirror: exactly one of the three survives.

import { connectorTokenOf } from './compat';
import type {
  CataloguePort,
  CatalogueFaceplate,
  CatalogueModel,
  CataloguePsuSlot,
  CatalogueSlotPosition,
} from '../api/catalogue';
// This session's brief — the cable panel's own "length in metres and
// ownership as editable values": `OWNERSHIP_VALUES` names the enum
// `cableView` below checks a stray `Cable.ownership` value against
// (`ownership` reads `null` for anything not in this list, the same guard
// `sheath` already gets), the same read `SHEATH_VALUES` already gives.
import { OWNERSHIP_VALUES, SHEATH_VALUES, type Sheath } from './cables';
import type { CableKind } from './compat';
import {
  edgesIn,
  edgesOut,
  findNode,
  parseEdgeId,
  parseNodeId,
  readChassisFields,
  readDeviceFields,
  readFixedToFields,
  readMountedInFields,
  readPassiveNodeFields,
  readPhysicalPortFields,
  readPowerSupplyFields,
  readRackFields,
  readSitsOnFields,
  readSurfaceFields,
  type Document,
  type GraphEdge,
  type GraphNode,
} from './model';

export type { CableKind, Sheath };

/** Where one placeable item (a Chassis or a PassiveNode) actually is,
 * reduced from whichever of `MountedIn` / `SitsOn` / `FixedTo` is live for it
 * (ADR-0051 §1). `'board'` is its own kind rather than folded into
 * `'surface'`: a board is itself a `FixtureView` (nested under its own
 * surface), so a thing `FixedTo` a board measures from the BOARD's edges,
 * not the wall's (`FixedTo`'s own schema doc) — the drawing needs to tell
 * the two apart to know which coordinate space `xMm`/`yMm` are in.
 * `commands.ts`'s `movePlacement` takes this same type on the write side. */
export type Placement =
  | { kind: 'rack'; rackId: string; positionU: number; face: 'front' | 'rear' }
  | { kind: 'shelf'; shelfId: string; slot: number }
  | { kind: 'surface'; surfaceId: string; xMm: number | null; yMm: number | null }
  | { kind: 'board'; boardId: string; xMm: number | null; yMm: number | null }
  | { kind: 'none' };

/** The far end of the cable filling a port, or `null` when the port is
 * free. `farPortId`/`farChassisId` are `null` when the far end is an
 * `ExternalPeer` (`connectToOutside`, `cables.ts`) rather than a
 * `PhysicalPort` — the modelling horizon (11 §6.3), same reading `outside`
 * gives `CableView.ends` below. `outsideCloset` is true whenever the far end
 * is not placed (ADR-0051 §1: `MountedIn` a rack, or `SitsOn` a shelf itself
 * `MountedIn` a rack) in a rack this `ClosetView` itself carries (an
 * ExternalPeer, a chassis racked at a different Premises, or — until a
 * surface/board reader needs the same distinction — a surface fixture). */
export interface CableEndView {
  cableId: string;
  farPortId: string | null;
  farChassisId: string | null;
  outsideCloset: boolean;
}

/** ADR-0050 §1: the FACEPLATE this port sits on — a device's own front or
 * rear panel — never to be confused with `ChassisView.face`, the face of the
 * RACK this chassis is mounted on. A rear-mounted chassis's front faceplate
 * still says `face: 'front'` here; it is the rack elevation, not this port
 * grouping, that decides which faceplate a viewer is looking at at any given
 * moment (ADR-0050 §1: "the rear faceplate of a front-mounted chassis, the
 * front faceplate of a rear-mounted one").
 *
 * ADR-0051 §1: `face` now reads `PhysicalPort.face` FIRST when the document
 * itself asserts one (`commands.ts`'s `placeChassis` and `addSketchPort`
 * both write it), falls back to the catalogue faceplate's own face when a
 * match is found (the rule this session's predecessor used exclusively),
 * and defaults to `'front'` when neither is available — never the chassis's
 * own mounting face, which is a fact about the RACK, not the port. */
export interface PortView {
  id: string;
  label: string;
  connector: string;
  row: number;
  column: number;
  uplink: boolean;
  /** The catalogue's own `role` (`api/catalogue.ts`'s `CataloguePort.role`),
   * carried through when a faceplate match supplies one; `null` for a PSU
   * inlet, a port on no catalogue faceplate, or a chassis with no catalogue
   * entry at all. `uplink` above is derived from this when it is present
   * (`role === 'uplink'`), the catalogue's own `uplink` bit otherwise. */
  role: 'access' | 'uplink' | 'management' | 'console' | null;
  face: 'front' | 'rear';
  /** ADR-0051 §1 — the id of the live `PassThrough` edge this port carries
   * ("these two holes are the same hole", `schema/schema.yaml`'s own doc),
   * `null` when this port passes nothing through. Degree above one (a
   * fan-out) is a real shape the schema allows; this is simply the first
   * live one found — the drawing's own rendering rule, not this view's. */
  passThroughId: string | null;
  cable: CableEndView | null;
  /** `PhysicalPort.service` (`schema/schema.yaml`; `document/compat.ts`'s
   * `PORT_SERVICE_VALUES`) — what the cage is for: `ethernet`, `pon`, `rf`,
   * `serial`, `console`, `management`, `power`, `other`. `null` when unset.
   * This session's brief — the selected port's own panel: "connector,
   * service, face." Typed optional, the same reason `CableView.lengthM`/
   * `.ownership` are (this file's own doc on that pattern, just above): a
   * `PortView` literal written before this session (several test fixtures'
   * own, off limits this session) still type-checks without naming it, and
   * every reader added this session treats a missing one exactly as an
   * explicit `null` (`port.service ?? null`). */
  service?: string | null;
}

/** One PSU slot (ADR-0050 §3/§4), joining the catalogue's own `psuSlots`
 * entry with whatever this document has fitted there. `position`/`hotSwap`
 * are the catalogue's, never guessed: a chassis with no matching catalogue
 * model draws no `InletView`s at all rather than invent them
 * (`psuInletsOf` below). */
export interface InletView extends PortView {
  slot: string;
  hotSwap: boolean;
  /** A fixed slot (`hotSwap: false`) is always `fitted: true` — "no part,
   * nothing to fit or remove" (ADR-0050 §4). A hot-swap slot is `fitted:
   * false` when no LIVE `PowerSupply` occupies it — `supplyId`/`cable` are
   * then both `null` and `id` is a synthetic `slot:<chassisId>:<slotName>`,
   * never a real node's id, so the drawing has something to address the
   * empty bay by without inventing a `PhysicalPort` nobody asserted. */
  fitted: boolean;
  supplyId: string | null;
  /** `PowerSupply.serial`/`.model` — present only when `supplyId` is (a
   * fixed slot's inlet has no `PowerSupply` node to read them off). Not in
   * the brief's own `InletView` sketch, added because the editor
   * (`Editor.tsx`, this session's brief item 5: "serial editable") has
   * nothing else to read a supply's serial from. */
  serial: string | null;
  model: string | null;
  position: CatalogueSlotPosition;
}

export interface ChassisView {
  id: string;
  deviceId: string;
  hostname: string;
  model: string;
  vendor: string;
  positionU: number;
  heightU: number;
  face: 'front' | 'rear';
  ports: PortView[];
  /** `Device.role`, `Device.management_address` and `Chassis.serial` —
   * `null` when the schema field is absent (UI-SPEC "Absent is drawn as
   * absent"; never an empty string standing in for unset). Read straight off
   * `node.fields` rather than through `readDeviceFields`/`readChassisFields`
   * (`document/model.ts`), which this session's brief does not extend. */
  role: string | null;
  managementAddress: string | null;
  serial: string | null;
  /** The chassis's PSU slots (ADR-0050 §3/§4), one per catalogue
   * `psuSlots` entry — kept out of `ports` above, which draws only what the
   * catalogue's own faceplate names. Empty when the chassis has no matching
   * catalogue model, or the model declares none. */
  psuInlets: InletView[];
  /** UI-SPEC "Power" / ADR-0050 §4: true when this chassis has two or more
   * FITTED inlets and exactly one of them is cabled. A chassis with a single
   * inlet, fed, is not single-fed — it has no second inlet to be short of —
   * it is simply fed; neither is a chassis with two inlets both fed, or
   * neither. */
  singleFed: boolean;
  /** ADR-0050 §4: true when this chassis has two or more PSU slots and at
   * least one of them is empty (no live supply fitted). */
  oneFitted: boolean;
  /** ADR-0051 §1 — where this chassis actually is: mounted in a rack, sat on
   * a shelf, fixed to a surface or a board, or `{ kind: 'none' }` when
   * nothing has placed it yet. A chassis reached through `RackView.chassis`
   * always has `kind: 'rack'`; one reached through `ShelfView.occupants` or
   * `SurfaceView.fixtures`/`FixtureView.fixtures` carries the matching
   * `'shelf'` / `'surface'` / `'board'` kind — this field is what lets the
   * editor draw the SAME chassis inspector regardless of which of the three
   * it opened it from. */
  placement: Placement;
  /** ADR-0051 §1 — true when this chassis has no catalogue model
   * (`Chassis.model` absent) and at least one port: its ports were typed by
   * hand (`commands.ts`'s `addSketchPort`), not read off a faceplate. */
  sketch: boolean;
}

export interface RackView {
  id: string;
  label: string;
  heightU: number;
  unitNumbering: string;
  chassis: ChassisView[];
  /** ADR-0051 §1 — every shelf `MountedIn` this rack, each with its own
   * occupants. A shelf is NOT also counted in `chassis` above (`rackView`
   * below splits `MountedIn`'s occupants by the mounted node's own kind). */
  shelves: ShelfView[];
  freeRuns: Array<{ fromU: number; toU: number }>;
  /** ADR-0050 §2 — `Rack.row`/`Rack.bay`, `null` when unset (a rack recorded
   * before its closet stop existed, or one whose row/bay nobody has typed
   * yet). */
  row: string | null;
  bay: number | null;
}

/** ADR-0051 §1 — one item `SitsOn` a shelf: a mini PC, a desktop switch, an
 * ONT, any `Chassis` or `PassiveNode`. */
export interface OccupantView {
  id: string;
  kind: 'chassis' | 'passive';
  label: string;
  model: string | null;
  slot: number;
  ports: PortView[];
  /** True when this occupant has no catalogue model and at least one port
   * (the same rule `ChassisView.sketch` uses, generalised to a passive
   * occupant too — a splitter or panel someone has drawn by hand). */
  sketch: boolean;
}

/** ADR-0051 §1 — a passive that takes U in place of a device's own; what
 * sits on it takes a slot rather than a unit (`SitsOn.slot`'s own schema
 * doc). */
export interface ShelfView {
  id: string;
  label: string;
  positionU: number;
  heightU: number;
  /** Sorted by `slot` ascending — left to right, the same order the shelf's
   * own render reads them (`design/places/renders/Shelf.png`). */
  occupants: OccupantView[];
}

/** ADR-0051 §1 — one item `FixedTo` a surface or a board: a floor-standing
 * UPS, an ONT screwed to a wall, an outlet block, a backboard itself (which
 * then carries its own nested `fixtures`). */
export interface FixtureView {
  id: string;
  kind: 'chassis' | 'passive';
  label: string;
  model: string | null;
  /** `PassiveNode.form` (e.g. `'outlet'`, `'board'`) for a passive fixture;
   * `null` for a chassis fixture — `Chassis` carries no `form` field. */
  form: string | null;
  /** `FixedTo.x_mm`/`.y_mm` — `null` when the position has not been
   * measured yet (`schema/schema.yaml`'s own doc on why both are `0..1`), a
   * true fact rather than a missing one. */
  xMm: number | null;
  yMm: number | null;
  ports: PortView[];
  /** A fixture's own power inlets and cables, drawn exactly like a rack
   * chassis's own (ADR-0050 §3/§4) — a floor-standing UPS needs this as much
   * as a rack-mounted one does. Empty for a passive fixture (a splitter, an
   * outlet block) — PSU slots are a chassis concept. */
  psuInlets: InletView[];
  /** A board's own occupants (`FixedTo` the board rather than the wall) —
   * empty for anything that is not itself a board. */
  fixtures: FixtureView[];
}

/** ADR-0051 §1 — a wall, floor, desk or ceiling a device or passive can be
 * `FixedTo`, drawn like a rack's elevation: flat, no rear, no flip. */
export interface SurfaceView {
  id: string;
  label: string;
  form: 'wall' | 'floor' | 'desk' | 'ceiling';
  widthMm: number | null;
  heightMm: number | null;
  fixtures: FixtureView[];
}

/** One row of the closet, as seen from the front (ADR-0050 §2): racks by
 * bay ascending. A rack with no `row` is its own `RowView`, `label: null`,
 * placed after every named row — never grouped with other unrowed racks,
 * which would assert a shared row nobody stated. The rear elevation's own
 * reversed bay order is a drawing-layer concern (ADR-0050 §2: "The flip is
 * one camera, never a page change"), not this view's — `rows` here is
 * always the one front-ascending order. */
export interface RowView {
  label: string | null;
  racks: RackView[];
}

/** One end of a `Cable` (`view.ts`'s own reduction of `Terminates`): a port
 * this document can place somewhere (ADR-0051 §1: `MountedIn` a rack,
 * `SitsOn` a shelf, or `FixedTo` a surface/board), or the outside world.
 * `rackId` is the owning rack when there is one — the port's own rack, or,
 * for a shelf occupant, the shelf's rack — and `null` for a surface/board
 * fixture, which has none. */
export type CableEnd = { portId: string; chassisId: string; rackId: string | null } | { outside: true; label: string };

export interface CableView {
  id: string;
  kind: CableKind;
  media: string;
  sheath: Sheath | null;
  label: string | null;
  /** `Cable.length_m` (`u32`, `schema/schema.yaml`), `null` when unset
   * (UI-SPEC "Absent is drawn as absent"). Named `lengthM` for the same
   * camelCase reading `Surface.width_mm` → `widthMm` already gives this
   * file's own fields. Typed optional (not the bare `number | null` every
   * other field on this interface carries) for the same reason
   * `contract.ts`'s own file header gives `PortView.cable`/`.cables`: a
   * `CableView` literal written before this session (`paths.test.ts`,
   * `portals.test.ts`) still type-checks without naming it, and every
   * reader added this session treats a missing one exactly as an explicit
   * `null` (`cable.lengthM ?? null`) — the two spellings carry the same
   * meaning throughout. `cableView` below always sets it. */
  lengthM?: number | null;
  /** `Cable.ownership` (`cables.ts`'s `OWNERSHIP_VALUES`), the raw string —
   * `null` when unset or, like `sheath`, when a document somehow holds a
   * value outside that enum. Plain `string`, not the narrower write-side
   * type, the same reading `media` above already gives. Optional for the
   * same reason `lengthM` above is. */
  ownership?: string | null;
  ends: CableEnd[];
}

export interface ClosetView {
  premisesId: string;
  racks: RackView[];
  cables: CableView[];
  /** `racks` grouped into rows (ADR-0050 §2) — see `RowView`'s own doc. */
  rows: RowView[];
  /** ADR-0051 §1 — every surface `HasSurface` this closet's premises. */
  surfaces: SurfaceView[];
}

function rowNumber(row: 'top' | 'bottom' | 'single'): number {
  // A drawing-layer grid position, not the catalogue's own token: two rows
  // (`top`/`bottom`) for a paired layout, one for `single`.
  return row === 'bottom' ? 1 : 0;
}

function isLiveNode(n: GraphNode): boolean {
  return n.absentSince === undefined;
}

function isLiveEdge(e: GraphEdge): boolean {
  return e.absentSince === undefined;
}

function catalogueMatch(catalogue: readonly CatalogueModel[], model: string): CatalogueModel | undefined {
  return catalogue.find((m) => m.model === model);
}

/** A field's string value straight off a node's `fields` map, or `null` when
 * it is absent or the node itself was not found — `document/model.ts`'s own
 * `fieldValue`/`asString` are private to that file, so this is a local,
 * read-only equivalent rather than a change to a module outside this
 * session's brief. */
function fieldString(node: GraphNode | undefined, key: string): string | null {
  const entry = node?.fields[key];
  if (!entry || entry.presence !== 'set') return null;
  return typeof entry.value === 'string' ? entry.value : null;
}

/** `fieldString`'s own numeric twin, added this session for `CableView.lengthM`
 * — the same "local, read-only equivalent" reasoning as `fieldString`'s own
 * doc: `document/model.ts`'s `asNumber` is private to that file. */
function fieldNumber(node: GraphNode | undefined, key: string): number | null {
  const entry = node?.fields[key];
  if (!entry || entry.presence !== 'set') return null;
  return typeof entry.value === 'number' ? entry.value : null;
}

/** Whichever live `Terminates` edge lands on `portId` (UI-SPEC "one cable
 * per port" — the command layer, `cables.ts`, refuses a second one; this is
 * a read, so it simply takes the first if that invariant were ever
 * violated by a document from elsewhere), reduced to the far end.
 * `closetRackIds` is the set of rack ids the `ClosetView` being built
 * itself carries — a far port whose owning rack (`rackIdOfPlacement`
 * above — a shelf occupant's own shelf's rack, for one) is not one of them
 * is `outsideCloset`. A surface/board fixture has no owning rack at all and
 * reads `outsideCloset: true` here the same way it always has — ADR-0051
 * §1/§2 gave it a place to draw, not yet a reader of this bit that needs to
 * tell it apart from a rack in a different closet. */
function portCableView(doc: Document, portId: string, closetRackIds: ReadonlySet<string>): CableEndView | null {
  const near = edgesIn(doc, portId, 'Terminates')[0];
  if (!near) return null;
  const cableId = near.from;
  const far = edgesOut(doc, cableId, 'Terminates').find((e) => e.id !== near.id);
  if (!far) {
    // A one-ended cable (out: "0..2" — the far end may simply not exist yet).
    return { cableId, farPortId: null, farChassisId: null, outsideCloset: false };
  }
  if (parseNodeId(far.to).kind === 'ExternalPeer') {
    return { cableId, farPortId: null, farChassisId: null, outsideCloset: true };
  }
  const farPortId = far.to;
  const farHasPort = edgesIn(doc, farPortId, 'HasPort')[0];
  const farChassisId = farHasPort?.from ?? null;
  const farRackId = farChassisId ? rackIdOfPlacement(doc, placementOf(doc, farChassisId)) : null;
  const outsideCloset = !farRackId || !closetRackIds.has(farRackId);
  return { cableId, farPortId, farChassisId, outsideCloset };
}

/** ADR-0051 §1 — the id of the live `PassThrough` edge carrying this port
 * through, in either direction (`PassThrough` is symmetric — `schema/schema.yaml`'s
 * own doc), or `null` when this port passes nothing through. */
function passThroughIdOf(doc: Document, portId: string): string | null {
  const edge = doc.edges.find(
    (e) => (e.from === portId || e.to === portId) && isLiveEdge(e) && parseEdgeId(e.id).kind === 'PassThrough',
  );
  return edge?.id ?? null;
}

/** A `CataloguePort`'s own label: the silkscreen number, or the vendor's own
 * word for a named port (ADR-0050 §5; `commands.ts`'s `placeChassis` writes
 * the same choice to `PhysicalPort.label`) — a port carries exactly one of
 * `number`/`name` (`api/catalogue.ts`'s module doc). */
function catalogueLabelOf(port: CataloguePort): string {
  return port.name ?? String(port.number);
}

function faceplatePortMatch(faceplate: CatalogueFaceplate, label: string, connector: string): CataloguePort | undefined {
  return faceplate.ports.find((p) => catalogueLabelOf(p) === label && connectorTokenOf(p.kind) === connector);
}

/** A port's own faceplate role (`api/catalogue.ts`'s `CataloguePort.role`)
 * and the `uplink` bit it derives: `role === 'uplink'` when a role is
 * known, the catalogue's own `uplink` bit otherwise — ADR-0050 §5's
 * "the fuller picture uplink is one bit of". */
function roleAndUplinkOf(match: CataloguePort): { role: PortView['role']; uplink: boolean } {
  if (match.role) return { role: match.role, uplink: match.role === 'uplink' };
  return { role: null, uplink: match.uplink };
}

function explicitFaceOf(face: string | undefined): 'front' | 'rear' | undefined {
  return face === 'front' || face === 'rear' ? face : undefined;
}

/** Natural, numeric-aware compare for a typed-by-hand port's own label —
 * `"eth2"` before `"eth10"`, not lexicographic order. Splits into runs of
 * digits and non-digits, comparing digit runs numerically. */
export function naturalLabelCompare(a: string, b: string): number {
  const parts = /\d+|\D+/g;
  const aParts = a.match(parts) ?? [];
  const bParts = b.match(parts) ?? [];
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i += 1) {
    const ap = aParts[i] ?? '';
    const bp = bParts[i] ?? '';
    if (ap === bp) continue;
    const aIsNum = /^\d+$/.test(ap);
    const bIsNum = /^\d+$/.test(bp);
    if (aIsNum && bIsNum) {
      const diff = Number(ap) - Number(bp);
      if (diff !== 0) return diff;
      continue; // e.g. "007" vs "7" — same value, keep comparing the rest
    }
    return ap < bp ? -1 : ap > bp ? 1 : 0;
  }
  return 0;
}

/** Sorted only when hand-typed (`hasCatalogueModel` false) — a catalogued
 * faceplate's own order is never touched. */
function sortIfHandTyped(ports: PortView[], hasCatalogueModel: boolean): PortView[] {
  if (hasCatalogueModel) return ports;
  return [...ports].sort((a, b) => naturalLabelCompare(a.label, b.label));
}

/** One port, matched against EVERY faceplate the catalogue model declares
 * (ADR-0050 §1: the rear elevation needs a chassis's rear faceplate ports
 * exactly as the front elevation needs its front ones, regardless of which
 * way the chassis is mounted) — tried in the model's own faceplate order,
 * first match wins. `face` follows ADR-0051 §1's rule (`PortView.face`'s own
 * doc): `PhysicalPort.face` when the document asserts one, else the matched
 * faceplate's face, else `'front'`. A port whose (label, connector) matches
 * no faceplate at all is not drawn here — `undefined` — unless there is no
 * catalogue model to consult, in which case the port is shown undecorated
 * rather than silently dropped: a real node this document holds is never
 * hidden for want of a catalogue lookup. */
function portView(
  doc: Document,
  portId: string,
  faceplates: readonly CatalogueFaceplate[],
  catalogueModelKnown: boolean,
  closetRackIds: ReadonlySet<string>,
): PortView | undefined {
  const node = findNode(doc, portId);
  const fields = node ? readPhysicalPortFields(node) : {};
  const label = fields.label ?? '';
  const connector = fields.connector ?? '';
  const cable = portCableView(doc, portId, closetRackIds);
  const passThroughId = passThroughIdOf(doc, portId);
  const explicit = explicitFaceOf(fields.face);
  for (const faceplate of faceplates) {
    const match = faceplatePortMatch(faceplate, label, connector);
    if (match) {
      const { role, uplink } = roleAndUplinkOf(match);
      return {
        id: portId,
        label,
        connector,
        row: rowNumber(match.row),
        column: match.column,
        uplink,
        role,
        face: explicit ?? faceplate.face,
        passThroughId,
        cable,
        service: fields.service ?? null,
      };
    }
  }
  if (catalogueModelKnown) return undefined;
  return {
    id: portId,
    label,
    connector,
    row: 0,
    column: 0,
    uplink: false,
    role: null,
    face: explicit ?? 'front',
    passThroughId,
    cable,
    service: fields.service ?? null,
  };
}

/** Every LIVE `FittedIn` this chassis has, whichever slot each is in. */
function fittedSupplies(doc: Document, chassisId: string): GraphEdge[] {
  return doc.edges.filter((e) => e.from === chassisId && isLiveEdge(e) && parseEdgeId(e.id).kind === 'FittedIn');
}

/** One `InletView` for a FIXED slot (`hotSwap: false`) — its `c14` inlet is
 * a `PhysicalPort` directly on the chassis (`commands.ts`'s `placeChassis`),
 * matched by `label`. Always `fitted: true` (ADR-0050 §4: nothing to fit or
 * remove); a synthetic id only if the port itself is somehow missing (a
 * document this session's own writer never produces, but `view.ts` never
 * assumes it is the only writer). */
function fixedInletView(
  doc: Document,
  chassisId: string,
  hasPorts: readonly GraphEdge[],
  slot: CataloguePsuSlot,
  closetRackIds: ReadonlySet<string>,
): InletView {
  const edge = hasPorts.find((e) => {
    const p = findNode(doc, e.to);
    if (!p || !isLiveNode(p)) return false;
    const f = readPhysicalPortFields(p);
    return f.connector === 'c14' && f.label === slot.name;
  });
  const node = edge ? findNode(doc, edge.to) : undefined;
  const fields = node ? readPhysicalPortFields(node) : {};
  return {
    id: edge?.to ?? `slot:${chassisId}:${slot.name}`,
    label: fields.label ?? slot.name,
    connector: fields.connector ?? 'c14',
    row: rowNumber(slot.position.row),
    column: slot.position.column,
    uplink: false,
    role: null,
    face: explicitFaceOf(fields.face) ?? slot.face,
    passThroughId: edge ? passThroughIdOf(doc, edge.to) : null,
    cable: edge ? portCableView(doc, edge.to, closetRackIds) : null,
    service: fields.service ?? null,
    slot: slot.name,
    hotSwap: false,
    fitted: true,
    supplyId: null,
    serial: null,
    model: null,
    position: slot.position,
  };
}

/** One `InletView` for a HOT-SWAP slot (`hotSwap: true`) — a live
 * `PowerSupply`, `FittedIn` this chassis, whose `PowerSupply.slot` matches;
 * `fitted: false` (and a synthetic id) when `removeSupply` (`supplies.ts`)
 * has emptied it, or it was never fitted. */
function hotSwapInletView(
  doc: Document,
  chassisId: string,
  fitted: readonly GraphEdge[],
  slot: CataloguePsuSlot,
  closetRackIds: ReadonlySet<string>,
): InletView {
  const fittedEdge = fitted.find((e) => {
    const supply = findNode(doc, e.to);
    return supply !== undefined && readPowerSupplyFields(supply).slot === slot.name;
  });
  const base = {
    row: rowNumber(slot.position.row),
    column: slot.position.column,
    uplink: false,
    role: null,
    slot: slot.name,
    hotSwap: true as const,
    position: slot.position,
  };
  if (!fittedEdge) {
    return {
      ...base,
      id: `slot:${chassisId}:${slot.name}`,
      label: slot.name,
      connector: 'c14',
      face: slot.face,
      passThroughId: null,
      cable: null,
      service: null,
      fitted: false,
      supplyId: null,
      serial: null,
      model: null,
    };
  }
  const supplyId = fittedEdge.to;
  const supplyNode = findNode(doc, supplyId);
  const supplyFields = supplyNode ? readPowerSupplyFields(supplyNode) : {};
  const inletEdge = edgesOut(doc, supplyId, 'HasPort')[0];
  const inletNode = inletEdge ? findNode(doc, inletEdge.to) : undefined;
  const portFields = inletNode ? readPhysicalPortFields(inletNode) : {};
  return {
    ...base,
    id: inletEdge?.to ?? `slot:${chassisId}:${slot.name}`,
    label: portFields.label ?? slot.name,
    connector: portFields.connector ?? 'c14',
    face: explicitFaceOf(portFields.face) ?? slot.face,
    passThroughId: inletEdge ? passThroughIdOf(doc, inletEdge.to) : null,
    cable: inletEdge ? portCableView(doc, inletEdge.to, closetRackIds) : null,
    service: portFields.service ?? null,
    fitted: true,
    supplyId,
    serial: supplyFields.serial ?? null,
    model: supplyFields.model ?? null,
  };
}

/** Every PSU slot the catalogue model declares, joined with what this
 * document has fitted (`fixedInletView`/`hotSwapInletView` above). Empty
 * when there is no catalogue model to read `psuSlots` from — `position`,
 * `hotSwap` and `face` all come from the catalogue, never guessed
 * (ADR-0050 §3: "the catalogue stops recording an inlet as a count"). */
function psuInletsOf(
  doc: Document,
  chassisId: string,
  catalogueModel: CatalogueModel | undefined,
  closetRackIds: ReadonlySet<string>,
): InletView[] {
  if (!catalogueModel) return [];
  const hasPorts = edgesOut(doc, chassisId, 'HasPort');
  const fitted = fittedSupplies(doc, chassisId);
  return catalogueModel.psuSlots.map((slot) =>
    slot.hotSwap
      ? hotSwapInletView(doc, chassisId, fitted, slot, closetRackIds)
      : fixedInletView(doc, chassisId, hasPorts, slot, closetRackIds),
  );
}

/** ADR-0051 §1 — where `itemId` (a Chassis or PassiveNode) actually is,
 * read off whichever of `MountedIn` / `SitsOn` / `FixedTo` is live for it —
 * `commands.ts`'s `movePlacement` doc: "exactly one … survives". A `FixedTo`
 * target that is itself a `PassiveNode` is a board (`'board'`); any other
 * live target is a `Surface` (`'surface'`) — `FixedTo.to` names no other
 * kind (`schema/schema.yaml`). */
function placementOf(doc: Document, itemId: string): Placement {
  const mounted = edgesOut(doc, itemId, 'MountedIn')[0];
  if (mounted) {
    const f = readMountedInFields(mounted);
    return { kind: 'rack', rackId: mounted.to, positionU: f.positionU ?? 1, face: f.face === 'rear' ? 'rear' : 'front' };
  }
  const sitsOn = edgesOut(doc, itemId, 'SitsOn')[0];
  if (sitsOn) {
    const f = readSitsOnFields(sitsOn);
    return { kind: 'shelf', shelfId: sitsOn.to, slot: f.slot ?? 0 };
  }
  const fixedTo = edgesOut(doc, itemId, 'FixedTo')[0];
  if (fixedTo) {
    const f = readFixedToFields(fixedTo);
    const xMm = f.xMm ?? null;
    const yMm = f.yMm ?? null;
    if (parseNodeId(fixedTo.to).kind === 'PassiveNode') {
      return { kind: 'board', boardId: fixedTo.to, xMm, yMm };
    }
    return { kind: 'surface', surfaceId: fixedTo.to, xMm, yMm };
  }
  return { kind: 'none' };
}

function chassisView(
  doc: Document,
  mountedEdgeId: string,
  catalogue: readonly CatalogueModel[],
  closetRackIds: ReadonlySet<string>,
): ChassisView | undefined {
  const mounted = doc.edges.find((e) => e.id === mountedEdgeId);
  if (!mounted) return undefined;
  const chassisId = mounted.from;
  const chassisNode = findNode(doc, chassisId);
  if (!chassisNode || !isLiveNode(chassisNode)) return undefined;

  const hasChassis = edgesIn(doc, chassisId, 'HasChassis')[0];
  const deviceId = hasChassis?.from ?? '';
  const deviceNode = deviceId ? findNode(doc, deviceId) : undefined;
  const hostname = deviceNode ? (readDeviceFields(deviceNode).hostname ?? '') : '';
  const role = fieldString(deviceNode, 'Device.role');
  const managementAddress = fieldString(deviceNode, 'Device.management_address');
  const serial = fieldString(chassisNode, 'Chassis.serial');

  const chassisFields = readChassisFields(chassisNode);
  const model = chassisFields.model ?? '';
  const catalogueModel = catalogueMatch(catalogue, model);

  const mountedFields = readMountedInFields(mounted);
  const face = mountedFields.face === 'rear' ? 'rear' : 'front';
  const heightU = catalogueModel?.rackUnits ?? mountedFields.heightU ?? 1;

  const hasPorts = edgesOut(doc, chassisId, 'HasPort');
  // Filters the chassis's `c14` PSU inlet out of `ports` only when a
  // catalogue model exists to route it into `psuInlets` instead.
  const otherEdges = hasPorts.filter((e) => {
    if (!catalogueModel) return true;
    const portNode = findNode(doc, e.to);
    return portNode === undefined || readPhysicalPortFields(portNode).connector !== 'c14';
  });

  const ports = sortIfHandTyped(
    otherEdges
      .map((e) => portView(doc, e.to, catalogueModel?.faceplates ?? [], catalogueModel !== undefined, closetRackIds))
      .filter((p): p is PortView => p !== undefined),
    catalogueModel !== undefined,
  );

  const psuInlets = psuInletsOf(doc, chassisId, catalogueModel, closetRackIds);
  const fittedInlets = psuInlets.filter((p) => p.fitted);
  const fedCount = fittedInlets.filter((p) => p.cable !== null).length;
  const singleFed = fittedInlets.length >= 2 && fedCount === 1;
  const oneFitted = psuInlets.length >= 2 && psuInlets.some((p) => !p.fitted);

  return {
    id: chassisId,
    deviceId,
    hostname,
    model,
    vendor: catalogueModel?.vendor ?? '',
    positionU: mountedFields.positionU ?? 1,
    heightU,
    face,
    ports,
    role,
    managementAddress,
    serial,
    psuInlets,
    singleFed,
    oneFitted,
    placement: placementOf(doc, chassisId),
    sketch: chassisFields.model === undefined && hasPorts.length > 0,
  };
}

/** ADR-0051 §1 — one item `SitsOn` a shelf, chassis or passive alike. */
function occupantView(
  doc: Document,
  sitsOnEdge: GraphEdge,
  catalogue: readonly CatalogueModel[],
  closetRackIds: ReadonlySet<string>,
): OccupantView | undefined {
  const itemId = sitsOnEdge.from;
  const node = findNode(doc, itemId);
  if (!node || !isLiveNode(node)) return undefined;
  const slot = readSitsOnFields(sitsOnEdge).slot ?? 0;
  const hasPorts = edgesOut(doc, itemId, 'HasPort');

  if (parseNodeId(itemId).kind === 'Chassis') {
    const hasChassis = edgesIn(doc, itemId, 'HasChassis')[0];
    const deviceId = hasChassis?.from ?? '';
    const deviceNode = deviceId ? findNode(doc, deviceId) : undefined;
    const label = deviceNode ? (readDeviceFields(deviceNode).hostname ?? '') : '';
    const chassisFields = readChassisFields(node);
    const model = chassisFields.model ?? null;
    const catalogueModel = chassisFields.model ? catalogueMatch(catalogue, chassisFields.model) : undefined;
    // ADR-0051 §1: unlike `chassisView`'s own `otherEdges` (which keeps a
    // fixed-slot c14 inlet out of `ports` so `psuInletsOf` can draw it once,
    // in `ChassisView.psuInlets`), `OccupantView` has no `psuInlets` field of
    // its own to route a c14 port to instead — its one `ports` list is the
    // occupant's WHOLE faceplate, inlet included (`elevation.ts`'s own
    // `ShelfOccupantFaceplateItem` doc). Filtering c14 out here the same way
    // would simply drop the port from the view entirely, never drawn
    // anywhere — `design/places/renders/Shelf.png`'s own `nuc-01` shows its
    // C14 inlet listed under one PORTS heading, not a separate strip.
    const ports = sortIfHandTyped(
      hasPorts
        .map((e) => portView(doc, e.to, catalogueModel?.faceplates ?? [], catalogueModel !== undefined, closetRackIds))
        .filter((p): p is PortView => p !== undefined),
      catalogueModel !== undefined,
    );
    return {
      id: itemId,
      kind: 'chassis',
      label,
      model,
      slot,
      ports,
      sketch: chassisFields.model === undefined && hasPorts.length > 0,
    };
  }

  const passiveFields = readPassiveNodeFields(node);
  const model = passiveFields.model ?? null;
  const catalogueModel = passiveFields.model ? catalogueMatch(catalogue, passiveFields.model) : undefined;
  const ports = sortIfHandTyped(
    hasPorts
      .map((e) => portView(doc, e.to, catalogueModel?.faceplates ?? [], catalogueModel !== undefined, closetRackIds))
      .filter((p): p is PortView => p !== undefined),
    catalogueModel !== undefined,
  );
  return {
    id: itemId,
    kind: 'passive',
    label: passiveFields.label ?? '',
    model,
    slot,
    ports,
    sketch: passiveFields.model === undefined && hasPorts.length > 0,
  };
}

function shelfView(
  doc: Document,
  mountedEdge: GraphEdge,
  catalogue: readonly CatalogueModel[],
  closetRackIds: ReadonlySet<string>,
): ShelfView | undefined {
  const shelfId = mountedEdge.from;
  const node = findNode(doc, shelfId);
  if (!node || !isLiveNode(node)) return undefined;
  const passiveFields = readPassiveNodeFields(node);
  const mountedFields = readMountedInFields(mountedEdge);
  const catalogueModel = passiveFields.model ? catalogueMatch(catalogue, passiveFields.model) : undefined;
  const heightU = catalogueModel?.rackUnits ?? mountedFields.heightU ?? 1;
  const occupants = edgesIn(doc, shelfId, 'SitsOn')
    .map((e) => occupantView(doc, e, catalogue, closetRackIds))
    .filter((o): o is OccupantView => o !== undefined)
    .sort((a, b) => a.slot - b.slot);
  return {
    id: shelfId,
    label: passiveFields.label ?? '',
    positionU: mountedFields.positionU ?? 1,
    heightU,
    occupants,
  };
}

/** ADR-0051 §1 — one item `FixedTo` `targetId` (a surface or a board),
 * recursing into its own nested `fixtures` when `itemId` is itself a board
 * (`PassiveNode` form `board`) other things are `FixedTo`. */
function fixtureView(
  doc: Document,
  itemId: string,
  xMm: number | null,
  yMm: number | null,
  catalogue: readonly CatalogueModel[],
  closetRackIds: ReadonlySet<string>,
): FixtureView | undefined {
  const node = findNode(doc, itemId);
  if (!node || !isLiveNode(node)) return undefined;

  let label: string;
  let model: string | null;
  let form: string | null;
  let ports: PortView[];
  let psuInlets: InletView[];
  const kind: FixtureView['kind'] = parseNodeId(itemId).kind === 'Chassis' ? 'chassis' : 'passive';

  if (kind === 'chassis') {
    const hasChassis = edgesIn(doc, itemId, 'HasChassis')[0];
    const deviceId = hasChassis?.from ?? '';
    const deviceNode = deviceId ? findNode(doc, deviceId) : undefined;
    label = deviceNode ? (readDeviceFields(deviceNode).hostname ?? '') : '';
    const chassisFields = readChassisFields(node);
    model = chassisFields.model ?? null;
    form = null;
    const catalogueModel = chassisFields.model ? catalogueMatch(catalogue, chassisFields.model) : undefined;
    const hasPorts = edgesOut(doc, itemId, 'HasPort');
    // `chassisView`'s own choice: a sketch fixture has no PSU slot for a
    // typed `c14` to route into, so it stays in `ports` rather than vanish.
    const otherEdges = hasPorts.filter((e) => {
      if (!catalogueModel) return true;
      const portNode = findNode(doc, e.to);
      return portNode === undefined || readPhysicalPortFields(portNode).connector !== 'c14';
    });
    ports = sortIfHandTyped(
      otherEdges
        .map((e) => portView(doc, e.to, catalogueModel?.faceplates ?? [], catalogueModel !== undefined, closetRackIds))
        .filter((p): p is PortView => p !== undefined),
      catalogueModel !== undefined,
    );
    psuInlets = psuInletsOf(doc, itemId, catalogueModel, closetRackIds);
  } else {
    const passiveFields = readPassiveNodeFields(node);
    label = passiveFields.label ?? '';
    model = passiveFields.model ?? null;
    form = passiveFields.form ?? null;
    const catalogueModel = passiveFields.model ? catalogueMatch(catalogue, passiveFields.model) : undefined;
    ports = sortIfHandTyped(
      edgesOut(doc, itemId, 'HasPort')
        .map((e) => portView(doc, e.to, catalogueModel?.faceplates ?? [], catalogueModel !== undefined, closetRackIds))
        .filter((p): p is PortView => p !== undefined),
      catalogueModel !== undefined,
    );
    psuInlets = [];
  }

  const nestedEdges = doc.edges.filter((e) => e.to === itemId && isLiveEdge(e) && parseEdgeId(e.id).kind === 'FixedTo');
  const fixtures = nestedEdges
    .map((e) => {
      const f = readFixedToFields(e);
      return fixtureView(doc, e.from, f.xMm ?? null, f.yMm ?? null, catalogue, closetRackIds);
    })
    .filter((f): f is FixtureView => f !== undefined);

  return { id: itemId, kind, label, model, form, xMm, yMm, ports, psuInlets, fixtures };
}

function surfaceView(
  doc: Document,
  surfaceId: string,
  catalogue: readonly CatalogueModel[],
  closetRackIds: ReadonlySet<string>,
): SurfaceView | undefined {
  const node = findNode(doc, surfaceId);
  if (!node || !isLiveNode(node)) return undefined;
  const fields = readSurfaceFields(node);
  const fixedEdges = doc.edges.filter((e) => e.to === surfaceId && isLiveEdge(e) && parseEdgeId(e.id).kind === 'FixedTo');
  const fixtures = fixedEdges
    .map((e) => {
      const f = readFixedToFields(e);
      return fixtureView(doc, e.from, f.xMm ?? null, f.yMm ?? null, catalogue, closetRackIds);
    })
    .filter((f): f is FixtureView => f !== undefined);
  const form =
    fields.form === 'wall' || fields.form === 'floor' || fields.form === 'desk' || fields.form === 'ceiling'
      ? fields.form
      : 'wall';
  return {
    id: surfaceId,
    label: fields.label ?? '',
    form,
    widthMm: fields.widthMm ?? null,
    heightMm: fields.heightMm ?? null,
    fixtures,
  };
}

function freeRuns(rackHeightU: number, occupied: readonly { positionU: number; heightU: number }[]): Array<{ fromU: number; toU: number }> {
  const taken = new Array<boolean>(rackHeightU + 1).fill(false); // 1-indexed
  for (const c of occupied) {
    for (let u = c.positionU; u < c.positionU + c.heightU && u <= rackHeightU; u += 1) {
      if (u >= 1) taken[u] = true;
    }
  }
  const runs: Array<{ fromU: number; toU: number }> = [];
  let runStart: number | undefined;
  for (let u = 1; u <= rackHeightU; u += 1) {
    if (!taken[u]) {
      if (runStart === undefined) runStart = u;
    } else if (runStart !== undefined) {
      runs.push({ fromU: runStart, toU: u - 1 });
      runStart = undefined;
    }
  }
  if (runStart !== undefined) runs.push({ fromU: runStart, toU: rackHeightU });
  return runs;
}

function rackView(
  doc: Document,
  rackId: string,
  catalogue: readonly CatalogueModel[],
  closetRackIds: ReadonlySet<string>,
): RackView | undefined {
  const node = findNode(doc, rackId);
  if (!node || !isLiveNode(node)) return undefined;
  const fields = readRackFields(node);
  const heightU = fields.heightU ?? 0;

  // ADR-0051 §1 widens `MountedIn.from` to `[Chassis, PassiveNode]` — a
  // shelf occupies rack units exactly as a chassis does. Split the live
  // `MountedIn` edges by the mounted node's own kind so a shelf is drawn as
  // a `ShelfView`, never also counted in `chassis` below.
  const mountedEdges = edgesIn(doc, rackId, 'MountedIn');
  const chassisEdges = mountedEdges.filter((e) => parseNodeId(e.from).kind === 'Chassis');
  const shelfEdges = mountedEdges.filter((e) => parseNodeId(e.from).kind === 'PassiveNode');

  const chassis = chassisEdges
    .map((e) => chassisView(doc, e.id, catalogue, closetRackIds))
    .filter((c): c is ChassisView => c !== undefined);
  const shelves = shelfEdges
    .map((e) => shelfView(doc, e, catalogue, closetRackIds))
    .filter((s): s is ShelfView => s !== undefined);

  const occupied = [
    ...chassis.map((c) => ({ positionU: c.positionU, heightU: c.heightU })),
    ...shelves.map((s) => ({ positionU: s.positionU, heightU: s.heightU })),
  ];

  return {
    id: rackId,
    label: fields.label ?? '',
    heightU,
    unitNumbering: fields.unitNumbering ?? '',
    chassis,
    shelves,
    freeRuns: freeRuns(heightU, occupied),
    row: fields.row ?? null,
    bay: fields.bay ?? null,
  };
}

/** `racks` grouped by `RackView.row`, front-ascending by `bay` within each
 * (ADR-0050 §2). Named rows sort by label, numerically aware so "Row 2"
 * precedes "Row 10" — the order a person expects, and a deterministic one:
 * creation order tied two racks made in the same millisecond to the random
 * half of their ulids, which made the row test flake on 2026-09-16. A rack
 * with no row is its own row, `label: null`, after every named one — never
 * grouped with other unrowed racks, which would assert a shared row nobody
 * stated. Two racks tied on `bay` (including two both `null`) order by
 * their own labels, the same way. */
function rowsOf(racks: readonly RackView[]): RowView[] {
  const named = new Map<string, RackView[]>();
  const namedOrder: string[] = [];
  const unrowed: RackView[] = [];
  for (const r of racks) {
    if (r.row !== null) {
      if (!named.has(r.row)) {
        named.set(r.row, []);
        namedOrder.push(r.row);
      }
      named.get(r.row)!.push(r);
    } else {
      unrowed.push(r);
    }
  }
  const byLabel = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  const byBayAscending = (a: RackView, b: RackView): number =>
    (a.bay ?? Number.POSITIVE_INFINITY) - (b.bay ?? Number.POSITIVE_INFINITY) || byLabel(a.label, b.label);
  const rows: RowView[] = [...namedOrder].sort(byLabel).map((label) => ({
    label,
    racks: [...named.get(label)!].sort(byBayAscending),
  }));
  for (const r of [...unrowed].sort((a, b) => byLabel(a.label, b.label))) rows.push({ label: null, racks: [r] });
  return rows;
}

/** `media` → `kind` (`compat.ts`'s `CableKind`, docs/UI-SPEC.md "Cables"):
 * `power` is power; `smf`/`mmf` are fibre; everything else (the copper
 * media, plus `virtual`/`other`/an unrecognised token) draws as copper. */
function cableKindOfMedia(media: string): CableKind {
  if (media === 'power') return 'power';
  if (media === 'smf' || media === 'mmf') return 'fibre';
  return 'copper';
}

/** The rack that owns `placement`, for `cableEnd`/`portCableView` below —
 * the placement's own rack when it is `MountedIn` one directly, or, for a
 * shelf occupant, the shelf's own rack (a shelf is itself `MountedIn` a
 * rack — `shelfView`'s own doc); `null` for a surface/board fixture or an
 * unplaced item, neither of which has one. */
function rackIdOfPlacement(doc: Document, placement: Placement): string | null {
  if (placement.kind === 'rack') return placement.rackId;
  if (placement.kind === 'shelf') {
    const mounted = edgesOut(doc, placement.shelfId, 'MountedIn')[0];
    return mounted ? mounted.to : null;
  }
  return null;
}

/** One `Terminates` edge off a `Cable`, resolved: a live `PhysicalPort`
 * placed somewhere (ADR-0051 §1: `MountedIn` a rack, `SitsOn` a shelf, or
 * `FixedTo` a surface/board — `placementOf`'s own three) becomes
 * `{portId, chassisId, rackId}`, `rackId` from `rackIdOfPlacement` above; a
 * live `ExternalPeer` becomes `{outside: true, label}` (`ExternalPeer.label`,
 * `schema/schema.yaml`, card "1" — `''` only if that invariant is somehow
 * violated). Anything this document cannot resolve (a dangling `to`, or a
 * port whose owner is not placed anywhere at all) is left out of
 * `CableView.ends` rather than guessed. */
function cableEnd(doc: Document, edge: GraphEdge): CableEnd | undefined {
  const kind = parseNodeId(edge.to).kind;
  if (kind === 'ExternalPeer') {
    const peer = findNode(doc, edge.to);
    if (!peer || !isLiveNode(peer)) return undefined;
    return { outside: true, label: fieldString(peer, 'ExternalPeer.label') ?? '' };
  }
  const portId = edge.to;
  const portNode = findNode(doc, portId);
  if (!portNode || !isLiveNode(portNode)) return undefined;
  const hasPort = edgesIn(doc, portId, 'HasPort')[0];
  if (!hasPort) return undefined;
  const chassisId = hasPort.from;
  const placement = placementOf(doc, chassisId);
  if (placement.kind === 'none') return undefined;
  return { portId, chassisId, rackId: rackIdOfPlacement(doc, placement) };
}

/** One `Cable` node, reduced for the drawing — `kind` from `media`,
 * `sheath` only when it is one of `SHEATH_VALUES` (`cables.ts`; a document
 * holding anything else is a shape this session's writer never produces),
 * `ends` from whatever live `Terminates` edges this cable actually has
 * (0, 1 — a one-ended or planned cable, 19 §3.4 — or 2). */
function cableView(doc: Document, node: GraphNode): CableView {
  const media = fieldString(node, 'Cable.media') ?? '';
  const sheathRaw = fieldString(node, 'Cable.sheath');
  const sheath = sheathRaw !== null && (SHEATH_VALUES as readonly string[]).includes(sheathRaw) ? (sheathRaw as Sheath) : null;
  const ownershipRaw = fieldString(node, 'Cable.ownership');
  const ownership = ownershipRaw !== null && (OWNERSHIP_VALUES as readonly string[]).includes(ownershipRaw) ? ownershipRaw : null;
  const ends = edgesOut(doc, node.id, 'Terminates')
    .map((e) => cableEnd(doc, e))
    .filter((e): e is CableEnd => e !== undefined);
  return {
    id: node.id,
    kind: cableKindOfMedia(media),
    media,
    sheath,
    label: fieldString(node, 'Cable.label'),
    lengthM: fieldNumber(node, 'Cable.length_m'),
    ownership,
    ends,
  };
}

/** The first live `Premises` this document carries, and every live `Rack`
 * `HasRack` hangs off it, and every live `Surface` `HasSurface` hangs off it
 * (ADR-0051 §1). A document with none is an empty closet, not a refusal —
 * nothing has been drawn yet. `cables` is every live `Cable` this document
 * holds, regardless of premises: `Cable` is root-level (`cables.ts`'s module
 * doc — `HasCable`'s `from: [root]` is not a containment edge this document
 * ever writes), found the same way `premises` above is, by scanning
 * `doc.nodes` for the kind rather than following an edge — "a cable spans
 * two premises and cannot be contained by one" (`schema/schema.yaml`'s own
 * doc on `HasCable`). */
export function viewOf(doc: Document, catalogue: CatalogueModel[]): ClosetView {
  const premises = doc.nodes.find(
    (n) => isLiveNode(n) && parseNodeId(n.id).kind === 'Premises',
  );
  const cables = doc.nodes
    .filter((n) => isLiveNode(n) && parseNodeId(n.id).kind === 'Cable')
    .map((n) => cableView(doc, n));
  if (!premises) {
    return { premisesId: '', racks: [], cables, rows: [], surfaces: [] };
  }
  const rackEdges = edgesOut(doc, premises.id, 'HasRack');
  const closetRackIds = new Set(rackEdges.map((e) => e.to));
  const racks = rackEdges
    .map((e) => rackView(doc, e.to, catalogue, closetRackIds))
    .filter((r): r is RackView => r !== undefined);
  const surfaceEdges = edgesOut(doc, premises.id, 'HasSurface');
  const surfaces = surfaceEdges
    .map((e) => surfaceView(doc, e.to, catalogue, closetRackIds))
    .filter((s): s is SurfaceView => s !== undefined);
  return { premisesId: premises.id, racks, cables, rows: rowsOf(racks), surfaces };
}
