import type { ChassisView, ClosetView, PortView, RackView } from './contract';
// `ShelfView`/`OccupantView`/`SurfaceView`/`FixtureView` are ADR-0051 §1's
// own new shapes — read straight off `document/view.ts`, the one place
// they are declared, for the same reason `elevation.ts`'s and
// `ShelfPlate.tsx`'s own file headers give: `./contract.ts` (off limits
// this session) has not widened its re-export list to carry them yet.
import type { FixtureView, OccupantView, ShelfView, SurfaceView } from '../../document/view';

/** Pure lookups over the view, shared by the editor and the drawing. Never
 * invents a result: each returns `undefined` when the id names nothing in
 * this view, rather than guessing. */

export function findRack(view: ClosetView, rackId: string): RackView | undefined {
  return view.racks.find((r) => r.id === rackId);
}

export function findChassis(
  view: ClosetView,
  chassisId: string,
): { rack: RackView; chassis: ChassisView } | undefined {
  for (const rack of view.racks) {
    const chassis = rack.chassis.find((c) => c.id === chassisId);
    if (chassis != null) return { rack, chassis };
  }
  return undefined;
}

export function findPort(
  view: ClosetView,
  portId: string,
): { rack: RackView; chassis: ChassisView; port: PortView } | undefined {
  for (const rack of view.racks) {
    for (const chassis of rack.chassis) {
      const port = chassis.ports.find((p) => p.id === portId);
      if (port != null) return { rack, chassis, port };
    }
  }
  return undefined;
}

/** Same lookup, widened to a chassis's `psuInlets` too — UI-SPEC "Power":
 * the inlets draw on the rack's own left rail, not the faceplate, so a
 * cable ending at one routes through the rack node's rail handle
 * (`Drawing.tsx`), not the chassis node's — `isPsuInlet` is what tells a
 * caller which handle to reach for. */
export function findAnyPort(
  view: ClosetView,
  portId: string,
): { rack: RackView; chassis: ChassisView; port: PortView; isPsuInlet: boolean } | undefined {
  const onFaceplate = findPort(view, portId);
  if (onFaceplate) return { ...onFaceplate, isPsuInlet: false };
  for (const rack of view.racks) {
    for (const chassis of rack.chassis) {
      const inlet = chassis.psuInlets.find((p) => p.id === portId);
      if (inlet != null) return { rack, chassis, port: inlet, isPsuInlet: true };
    }
  }
  return undefined;
}

/** ADR-0051 §1 — a port on a shelf occupant (`RackView.shelves[].occupants[].ports`,
 * `ShelfPlate.tsx`'s own faceplate), found the same way `findPort` finds one
 * on a rack chassis's own: `undefined` when no shelf occupant in this view
 * carries it, never invented. An occupant's own PSU inlet (if it has one)
 * is already one of its `ports` (`elevation.ts`'s own note: unlike
 * `ChassisView`, `OccupantView` has no separate `psuInlets` list), so there
 * is nothing extra to search here the way `findAnyPort` above needs for a
 * chassis. */
export function findShelfOccupantPort(
  view: ClosetView,
  portId: string,
): { rack: RackView; shelf: ShelfView; occupant: OccupantView; port: PortView } | undefined {
  for (const rack of view.racks) {
    for (const shelf of rack.shelves ?? []) {
      for (const occupant of shelf.occupants) {
        const port = occupant.ports.find((p) => p.id === portId);
        if (port != null) return { rack, shelf, occupant, port };
      }
    }
  }
  return undefined;
}

/** One surface's own fixtures, searched depth first — a board's own ports
 * (a passthrough panel screwed straight to the board itself) before its
 * nested fixtures' (`FixtureView.fixtures`, "a board carries its own
 * fixtures," `SurfaceNode.tsx`'s own file header), and each fixture's
 * `psuInlets` (the same `InletView[]` shape a rack chassis's own carries)
 * alongside its ordinary `ports`. Not exported: `findSurfaceFixturePort`
 * below is the one entry point, the same shape `findPort`/`findAnyPort`
 * give a caller for a rack chassis. */
function findInFixtures(
  surface: SurfaceView,
  fixtures: readonly FixtureView[],
  portId: string,
): { surface: SurfaceView; fixture: FixtureView; port: PortView; isPsuInlet: boolean } | undefined {
  for (const fixture of fixtures) {
    const onFaceplate = fixture.ports.find((p) => p.id === portId);
    if (onFaceplate != null) return { surface, fixture, port: onFaceplate, isPsuInlet: false };
    const inlet = fixture.psuInlets.find((p) => p.id === portId);
    if (inlet != null) return { surface, fixture, port: inlet, isPsuInlet: true };
    const nested = findInFixtures(surface, fixture.fixtures, portId);
    if (nested) return nested;
  }
  return undefined;
}

/** ADR-0051 §1 — a port on a surface fixture (a floor-standing UPS, an ONT
 * screwed to a wall, an outlet block on a board), wherever it sits in the
 * closet's surfaces: `undefined` when no fixture in this view carries it,
 * never invented — the same "search, never guess" rule every lookup in this
 * module already keeps. */
export function findSurfaceFixturePort(
  view: ClosetView,
  portId: string,
): { surface: SurfaceView; fixture: FixtureView; port: PortView; isPsuInlet: boolean } | undefined {
  for (const surface of view.surfaces ?? []) {
    const found = findInFixtures(surface, surface.fixtures, portId);
    if (found) return found;
  }
  return undefined;
}

/** Where a port is, ANYWHERE this closet draws one — a rack chassis's own
 * faceplate or rail inlet (`findAnyPort`), a shelf occupant's (`findShelfOccupantPort`),
 * or a surface fixture's (`findSurfaceFixturePort`), tried in that order.
 * `Drawing.tsx`'s one entry point for resolving a drag-to-connect end or a
 * cable's own end to a real node/handle regardless of which of the three
 * places it lands in (ADR-0051 §1/§2: a shelf occupant or a surface
 * fixture's ports resolve to a real handle exactly as a chassis port
 * already does). `undefined` when this view carries no such port at all. */
export type PortLocation =
  | ({ place: 'chassis' } & NonNullable<ReturnType<typeof findAnyPort>>)
  | ({ place: 'shelf' } & NonNullable<ReturnType<typeof findShelfOccupantPort>>)
  | ({ place: 'fixture' } & NonNullable<ReturnType<typeof findSurfaceFixturePort>>);

export function locatePort(view: ClosetView, portId: string): PortLocation | undefined {
  const onChassis = findAnyPort(view, portId);
  if (onChassis) return { place: 'chassis', ...onChassis };
  const onShelf = findShelfOccupantPort(view, portId);
  if (onShelf) return { place: 'shelf', ...onShelf };
  const onFixture = findSurfaceFixturePort(view, portId);
  if (onFixture) return { place: 'fixture', ...onFixture };
  return undefined;
}
