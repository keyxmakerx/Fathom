/**
 * The rear elevation — `docs/decisions/adr-0050-the-rear-elevation.md` §1,
 * replacing Session 5's `faces.ts` front|rear flip (which changed *which
 * chassis drew*) with a true elevation (which changes *which faceplate of
 * each chassis draws*). Pure: a `ChassisView` and the elevation a person is
 * looking at, in — the faceplate that faces that way, its ports, its inlets
 * and whether there is nothing on it to draw but the chassis's own name, out.
 * No DOM, no React Flow.
 */

import type { CameraStop } from './geometry';
import type { ChassisView, InletView, PortView } from './contract';
// `ShelfView`/`OccupantView` are this session's own new shapes (ADR-0051 §1,
// the brief's own CONTRACT block) — not yet in `./contract`'s re-export list
// (that file is off limits this session; the lead widens it once the shelf
// track lands for good, the same "switches back to a plain re-export" note
// `./contract`'s own file header already carries for a prior seam). Read
// straight off `document/view.ts`, the one place they are declared, exactly
// as `./contract.ts` itself does for every type it re-exports.
import type { OccupantView, ShelfView } from '../../document/view';

export type Facing = 'front' | 'rear';

/**
 * ADR-0050 §1: "the rear elevation draws... the rear faceplate of a
 * front-mounted chassis, the front faceplate of a rear-mounted one." By the
 * same rule read the other way, the front elevation draws the front
 * faceplate of a front-mounted chassis and the rear faceplate of a
 * rear-mounted one. Both halves reduce to one rule: the visible faceplate is
 * `'front'` exactly when the elevation matches the chassis's own mounting
 * face, `'rear'` otherwise.
 */
export function visibleFaceOf(mountingFace: Facing, elevation: Facing): Facing {
  return elevation === mountingFace ? 'front' : 'rear';
}

/** One chassis, resolved for an elevation: which faceplate faces that way,
 * the ports and inlets that faceplate actually carries (`ChassisView.ports`/
 * `psuInlets` carry both faceplates at once, this session's contract —
 * `PortView.face`/`InletView.face` is what this filters on), and whether
 * there is nothing on that face but the chassis's own name — ADR-0050 §1:
 * "a plain plate carrying its name, never nothing." */
export interface FaceplateItem {
  chassis: ChassisView;
  visibleFace: Facing;
  ports: PortView[];
  inlets: InletView[];
  /** True when `ports` and `inlets` are both empty — the caller draws the
   * chassis's header (hostname) and nothing else, never a blank box. */
  plainPlate: boolean;
}

export function faceplateItem(chassis: ChassisView, elevation: Facing): FaceplateItem {
  const visibleFace = visibleFaceOf(chassis.face, elevation);
  const ports = chassis.ports.filter((p) => p.face === visibleFace);
  const inlets = chassis.psuInlets.filter((p) => p.face === visibleFace);
  return { chassis, visibleFace, ports, inlets, plainPlate: ports.length === 0 && inlets.length === 0 };
}

/** Every chassis in a rack, resolved for one elevation — ADR-0050 §1: unlike
 * the retired `faces.ts`, every mounted chassis draws at every elevation
 * (as its own faceplate, or as a plain plate); nothing is filtered out by
 * mounting face. */
export function faceplateItems(chassis: readonly ChassisView[], elevation: Facing): FaceplateItem[] {
  return chassis.map((c) => faceplateItem(c, elevation));
}

/** Where a PSU inlet's own power lead ends — s6f #1, `docs/decisions/adr-0050-the-rear-elevation.md`
 * §1: "in the front elevation it ends on the rail hexagon as today... in
 * the rear elevation a power lead ends on the inlet on the face." The rear
 * elevation reading is refined once more by the camera stop: the inlet's
 * own handle (`ChassisNode.tsx`'s `InletGlyph`) only exists once the inlet
 * strip itself has drawn, which is only reliable at the faceplate stop (the
 * strip mounts and is measured by React Flow within the same render at
 * that zoom; at the closet and rack stops the strip's own conditional mount
 * can lag a render behind the elevation flip that triggers it). The closet
 * and rack stops route to the chassis's own stable anchor instead — "the
 * plate's inlet-end edge, the same side the strip sits on"
 * (`ChassisNode.tsx`'s `INLET_ANCHOR_HANDLE_ID`) — always present whenever
 * the chassis itself draws in the rear elevation. */
export function powerLeadHandle(elevation: Facing, cameraStop: CameraStop): 'rail' | 'anchor' | 'inlet' {
  if (elevation === 'front') return 'rail';
  return cameraStop === 'faceplate' ? 'inlet' : 'anchor';
}

/** One occupant sitting on a shelf, resolved for an elevation. The rule,
 * from ADR-0051 §1 and the Shelf board (`design/places/renders/Shelf.png`):
 * a shelf's occupants show in both elevations, front and rear faces per
 * occupant by the same rule as a chassis. `OccupantView`
 * (this session's own CONTRACT) carries no mounting face of its own the way
 * `ChassisView.face` does: a shelf does not flip independently of the rack
 * it is mounted in (there is no separate `SitsOn`-side "front | rear"
 * control anywhere in ADR-0051 §1 or the Shelf board), so the plainest
 * reading — and the one this function takes — is that an occupant sits with
 * its own front always facing the rack's own front, i.e. `visibleFaceOf`'s
 * `mountingFace` fixed at `'front'`, which collapses to "the visible face
 * IS the elevation." Named here, not silently assumed, for the lead to
 * confirm or correct — the same caveat this file's sibling `paths.ts`
 * carries for its own inferred rules. */
export interface ShelfOccupantFaceplateItem {
  occupant: OccupantView;
  visibleFace: Facing;
  /** `occupant.ports` already carries an occupant's PSU inlet alongside its
   * ordinary ports (this session's CONTRACT: `OccupantView` has one `ports`
   * list, unlike `ChassisView`'s separate `ports`/`psuInlets` — a sketch
   * device's inlet is typed by hand exactly like its data ports, UI-SPEC
   * "Places"'s own `nuc-01` example, C14 inlet included under one
   * "PORTS" heading). So, unlike `FaceplateItem` above, there is no second
   * `inlets` field here to filter — this is the whole faceplate. */
  ports: PortView[];
}

export function shelfOccupantFaceplateItem(occupant: OccupantView, elevation: Facing): ShelfOccupantFaceplateItem {
  const visibleFace = visibleFaceOf('front', elevation);
  return { occupant, visibleFace, ports: occupant.ports.filter((p) => p.face === visibleFace) };
}

/** Every occupant on one shelf, resolved for one elevation — `ShelfPlate.tsx`'s
 * own analogue of `faceplateItems` above. */
export function shelfOccupantFaceplateItems(
  shelf: Pick<ShelfView, 'occupants'>,
  elevation: Facing,
): ShelfOccupantFaceplateItem[] {
  return shelf.occupants.map((o) => shelfOccupantFaceplateItem(o, elevation));
}
