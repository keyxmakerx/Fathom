/**
 * Which face's chassis draw, for a rack, at a given camera stop —
 * `docs/UI-SPEC.md` "Power": "Rear view: stacked under the front when
 * zoomed, a flip at rack scale," and this session's own build note: "at the
 * rack stop a small front | rear flip in the rack header... switches which
 * face's chassis are drawn; at the faceplate stop a rear-mounted chassis
 * draws stacked beneath its front neighbour at the same units, labelled
 * rear... A rear-mounted chassis is never a silent gap again." Pure: a
 * `RackView`, the current camera stop and (for the flip) which face a
 * person chose in, out — no DOM, no React Flow.
 */

import type { CameraStop } from './geometry';
import type { ChassisView, RackView } from './contract';

export type Facing = 'front' | 'rear';

export interface FaceLayoutItem {
  chassis: ChassisView;
  /** True for a `face: 'rear'` chassis drawn as the stacked annotation
   * (faceplate stop) or as the flipped-to face (rack/closet stop) — never
   * true for a `face: 'front'` chassis, so a caller can label the box
   * "rear" purely off this flag rather than re-reading `chassis.face`. */
  rear: boolean;
  /** At the faceplate stop only: the id of the front-mounted chassis this
   * rear one stacks directly beneath, when one shares its `positionU` —
   * `undefined` for a rear chassis with no front neighbour at that
   * position, which still draws (in its own reserved run) rather than
   * being silently skipped. */
  stackedUnderChassisId?: string;
}

/**
 * `docs/UI-SPEC.md`'s own two regimes:
 *
 * - **faceplate stop**: every front chassis draws normally, and every rear
 *   chassis draws too — stacked beneath its front neighbour when one shares
 *   its `positionU`, or in its own reserved run otherwise. Both faces are
 *   visible at once; there is nothing to flip.
 * - **closet and rack stops**: `facing` alone decides — only that face's
 *   chassis draw, exactly as `front | rear` in the rack header reads.
 */
export function chassisToDraw(rack: Pick<RackView, 'chassis'>, cameraStop: CameraStop, facing: Facing): FaceLayoutItem[] {
  if (cameraStop === 'faceplate') {
    const front = rack.chassis.filter((c) => c.face === 'front');
    const rear = rack.chassis.filter((c) => c.face === 'rear');
    const items: FaceLayoutItem[] = front.map((chassis) => ({ chassis, rear: false }));
    for (const chassis of rear) {
      const under = front.find((f) => f.positionU === chassis.positionU);
      items.push({ chassis, rear: true, stackedUnderChassisId: under?.id });
    }
    return items;
  }
  return rack.chassis.filter((c) => c.face === facing).map((chassis) => ({ chassis, rear: facing === 'rear' }));
}
