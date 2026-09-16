/**
 * The rear elevation — `docs/decisions/adr-0050-the-rear-elevation.md` §1,
 * replacing Session 5's `faces.ts` front|rear flip (which changed *which
 * chassis drew*) with a true elevation (which changes *which faceplate of
 * each chassis draws*). Pure: a `ChassisView` and the elevation a person is
 * looking at, in — the faceplate that faces that way, its ports, its inlets
 * and whether there is nothing on it to draw but the chassis's own name, out.
 * No DOM, no React Flow.
 */

import type { ChassisView, InletView, PortView } from './contract';

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
