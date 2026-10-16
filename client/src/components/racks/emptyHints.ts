// What an empty design says, and when Equipment opens by itself (ADR-0065 §3). The Equipment list is the
// first tab of the dock on the RIGHT edge (`shell/RightDock.tsx`); the words here must name that side.

import type { FixtureView } from '../../document/view';
import type { ClosetView } from '../drawing/contract';

/** The side Equipment is on. One place, so the hints, the button's label and their tests agree. */
export const EQUIPMENT_SIDE = 'right';

/** What a design with nothing in it says (ADR-0060 decision 4). */
export const EMPTY_HINT = `An empty design. Open the Equipment tab on the ${EQUIPMENT_SIDE} edge and drag a device onto the rack, or right-click the canvas to add a rack or a wall.`;

/** What an opened device with nothing yet in it says. */
export const JOT_HINT = `Open the Equipment tab on the ${EQUIPMENT_SIDE} edge, then drag an item here or click it. Draw a cable from one port to another.`;

/** The words on the canvas button that opens the Equipment tab. */
export const ADD_EQUIPMENT_LABEL = 'Add equipment';

const fixturesIn = (fixtures: readonly FixtureView[]): number => fixtures.reduce((n, f) => n + 1 + fixturesIn(f.fixtures), 0);

/** True when the design holds no device at all: no racked, shelved, fixed, unplaced or free device. A rack
 * with nothing in it counts as empty, because the first thing a person does there is add equipment. */
export function designHasNoDevices(view: ClosetView): boolean {
  const racked = view.racks.some((r) => r.chassis.length > 0 || (r.shelves ?? []).some((s) => s.occupants.length > 0));
  const fixed = (view.surfaces ?? []).some((s) => fixturesIn(s.fixtures) > 0);
  return !racked && !fixed && view.unplaced.length === 0 && view.free.length === 0;
}

/** Whether Equipment should open by itself: the design has loaded, can be drawn in, and holds no device.
 * `undefined` until it has loaded (`useRightTab` decides once, on the first answer). */
export function autoOpenEquipment(loaded: boolean, canDraw: boolean, view: ClosetView): boolean | undefined {
  if (!loaded) return undefined;
  return canDraw && designHasNoDevices(view);
}
