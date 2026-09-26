import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';

import { C14 } from '../ports';
import type { Facing, FaceplateItem } from './elevation';
import type { RackView } from './contract';
import { RACK_HEADER_PX, RACK_INNER_PX, RAIL_PX, U_PX, sortFreeRuns } from './geometry';
import { useLive } from './liveStore';

/** The C14 glyph's true (`scale` 1) box is 22×16 (`components/ports/C14.tsx`'s
 * `frame(22, 16)`) — UI-SPEC "Power": "the C14 glyph... at rail scale," read
 * as small enough that two sit side by side inside the 28px rail
 * (`RAIL_PX`) the way `Main.dc.html`'s own rail hexagons do (two ~6px-wide
 * marks with a few px between, inside a 28px-wide rail). No board states an
 * exact rail-scale number; chosen here as the plainest that clears that
 * fit, the same kind of session choice `RACK_GAP_PX` is. */
const PSU_HEX_SCALE = 0.42;
const PSU_HEX_WIDTH = 23 * PSU_HEX_SCALE; // C14's own `frame(22,16)` box is 23×17
const PSU_HEX_HEIGHT = 17 * PSU_HEX_SCALE;
/** Horizontal spacing between two inlet marks on the same row — `Main.dc.html`'s
 * own dual-inlet paths sit ~10px apart, centre to centre. */
const PSU_HEX_GAP_PX = 10;

export interface RackNodeData extends Record<string, unknown> {
  rack: RackView;
  /** Every mounted chassis, resolved for this rack's current elevation
   * (`elevation.ts`'s own `faceplateItems`) — ADR-0050 §1: unlike the
   * retired `faces.ts` flip, every chassis draws at every elevation, so this
   * is no longer a filtered subset; it is what the rail's PSU marks (front
   * elevation only — see `elevation` below) are built from, so they always
   * match what is actually on screen rather than this node re-deriving the
   * face on its own. */
  chassisItems: readonly FaceplateItem[];
  /** ADR-0050 §1: "a flip at rack scale." At the closet stop this is set by
   * the row's own flip; at the rack and faceplate stops, by this rack's own
   * control below. */
  elevation: Facing;
  onFlip: () => void;
  /** ADR-0050 §3 / s6f #2: "the rail hexagons... light the inlet they stand
   * for" — hovering one calls this with its own inlet's cable id (`null` on
   * leave, or when the inlet carries no cable to light), the exact
   * `setHoveredCableId` a `CableEdge`'s own hover already calls
   * (`Drawing.tsx`), so the two share one piece of state rather than two
   * that happen to agree. */
  onHoverInlet: (cableId: string | null) => void;
}

export type RackNodeType = Node<RackNodeData, 'rack'>;

/** `selected`, `dropPreview` and `shaking` live in the external store —
 * each selector answers for this rack alone, so a change elsewhere never
 * rebuilds this rack's own node. */
function useRackLiveData(rackId: string) {
  const selected = useLive((s) => s.selected?.kind === 'rack' && s.selected.id === rackId);
  const dropPreview = useLive((s) => s.dropPreview[rackId] ?? null);
  const shaking = useLive((s) => s.shakingRackId === rackId);
  return { selected, dropPreview, shaking };
}

/** One inlet's rail position: `chassis`'s own row, `index` of `count`
 * siblings on that row, centred in the rail that currently carries the
 * numbering (`railSide`, below) — ADR-0050 §1: "the rail... unit numbers
 * with it," so the PSU marks (drawn only in the front elevation, where the
 * rail hexagon is still how a power lead ends) travel with the same rail
 * the U numbers do rather than staying pinned to a fixed side. */
function psuSlot(rack: RackView, chassis: FaceplateItem['chassis'], index: number, count: number): { left: number; top: number } {
  const rowTop = (rack.heightU - (chassis.positionU + chassis.heightU - 1)) * U_PX;
  const rowHeight = chassis.heightU * U_PX;
  const centreX = RAIL_PX / 2 + (index - (count - 1) / 2) * PSU_HEX_GAP_PX;
  const centreY = rowTop + rowHeight / 2;
  return { left: centreX - PSU_HEX_WIDTH / 2, top: centreY - PSU_HEX_HEIGHT / 2 };
}

/** Rails, U numbers, hatched free runs — drawn exactly as `design/shell/Main.dc.html`
 * and `design/shell/Lenses.dc.html` draw them, mirrored for the rear
 * elevation (ADR-0050 §1: "the rail that is on the left from the front is on
 * the right from behind, unit numbers with it"). Chassis are not drawn here:
 * they are sibling React Flow nodes positioned to align with this rack's
 * frame (`Drawing.tsx`), so a chassis can be dragged from one rack's frame
 * to another's without this node re-rendering.
 *
 * The mirror is a RE-LAYOUT (which rail hosts the numbering), not a CSS
 * transform on the frame: ADR-0050 §1 is explicit that "a faceplate's own
 * layout does not mirror," and a `scaleX(-1)` on the whole frame would flip
 * the device column (and everything React Flow stacks over it, `Drawing.tsx`'s
 * sibling `ChassisNode`s) along with the rails — mirroring exactly the
 * content the decision says must not mirror. Swapping which side element
 * carries the numbering leaves the device column, and everything positioned
 * over it, untouched. */
export function RackNode({ data }: NodeProps<RackNodeType>) {
  const { rack, chassisItems, elevation, onFlip, onHoverInlet } = data;
  const { selected, dropPreview, shaking } = useRackLiveData(rack.id);
  const frameHeight = rack.heightU * U_PX;
  const usedU = rack.chassis.reduce((sum, c) => sum + c.heightU, 0);
  const runs = sortFreeRuns(rack.freeRuns);
  const width = RAIL_PX * 2 + RACK_INNER_PX;

  // ADR-0050 §1: rail hexagons are the front elevation's own way for a power
  // lead to end ("as today"); the rear elevation's leads end directly on the
  // inlet strip drawn on the chassis's own rear faceplate (`ChassisNode.tsx`)
  // instead, so nothing is drawn on the rail there.
  const railInlets =
    elevation === 'front'
      ? chassisItems.flatMap((item) => item.inlets.map((inlet, i) => ({ chassis: item.chassis, inlet, i, count: item.inlets.length })))
      : [];

  const railSide: 'left' | 'right' = elevation === 'rear' ? 'right' : 'left';

  return (
    <div
      className={['drawing-rack', selected ? 'drawing-rack--selected' : '', shaking ? 'drawing-rack--shake' : '']
        .filter(Boolean)
        .join(' ')}
      style={{ width }}
    >
      <div className="drawing-rack__label">
        <span className="drawing-rack__label-text">
          {rack.label} &middot; {rack.heightU}U &middot; {usedU} used
        </span>
        {/* Always mounted; `drawing.css` hides it outside the rack stop by
            `data-camera-stop` on the drawing's own wrapper, so this idle
            button never has to read the viewport itself. */}
        <span className="drawing-rack__flip nodrag">
          <button
            type="button"
            className={elevation === 'front' ? 'drawing-rack__face drawing-rack__face--on' : 'drawing-rack__face'}
            onClick={(e) => {
              e.stopPropagation();
              if (elevation !== 'front') onFlip();
            }}
          >
            front
          </button>
          <span aria-hidden="true"> | </span>
          <button
            type="button"
            className={elevation === 'rear' ? 'drawing-rack__face drawing-rack__face--on' : 'drawing-rack__face'}
            onClick={(e) => {
              e.stopPropagation();
              if (elevation !== 'rear') onFlip();
            }}
          >
            rear
          </button>
        </span>
      </div>
      <div className="drawing-rack__frame" style={{ height: frameHeight }}>
        <div className="drawing-rack__rail drawing-rack__rail--left" style={{ width: RAIL_PX }}>
          {railSide === 'left' && (
            <>
              {/* UI-SPEC "Power": "Each device's PSU inlets notated on the
                  left rail beside it — two hexagons for dual, filled when
                  fed" (the front elevation only, ADR-0050 §1). */}
              {railInlets.map(({ chassis, inlet, i, count }) => {
                const slot = psuSlot(rack, chassis, i, count);
                return (
                  <div
                    key={inlet.id}
                    className="drawing-rack__psu"
                    style={{ left: slot.left, top: slot.top, width: PSU_HEX_WIDTH, height: PSU_HEX_HEIGHT }}
                    onMouseEnter={() => onHoverInlet(inlet.cable?.cableId ?? null)}
                    onMouseLeave={() => onHoverInlet(null)}
                  >
                    <C14 cabled={inlet.cable != null} scale={PSU_HEX_SCALE} title={`${chassis.hostname || 'unnamed'} ${inlet.slot || `PSU ${i + 1}`}`} />
                    <Handle type="source" position={Position.Left} id={inlet.id} className="drawing-rack__psu-handle" />
                  </div>
                );
              })}
              <div className="drawing-rack__u-numbers drawing-rack__u-numbers--left" style={{ width: RAIL_PX }}>
                {Array.from({ length: rack.heightU }, (_, i) => rack.heightU - i).map((u) => (
                  <div key={u} className="drawing-rack__u-number" style={{ height: U_PX }}>
                    {u}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="drawing-rack__rail drawing-rack__rail--right" style={{ width: RAIL_PX }}>
          {railSide === 'right' && (
            <div className="drawing-rack__u-numbers drawing-rack__u-numbers--right" style={{ width: RAIL_PX }}>
              {Array.from({ length: rack.heightU }, (_, i) => rack.heightU - i).map((u) => (
                <div key={u} className="drawing-rack__u-number" style={{ height: U_PX }}>
                  {u}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="drawing-rack__device-column" style={{ left: RAIL_PX, width: RACK_INNER_PX }}>
          {runs.map((run) => {
            const top = (rack.heightU - run.toU) * U_PX;
            const height = (run.toU - run.fromU + 1) * U_PX;
            return (
              <div
                key={`${run.fromU}-${run.toU}`}
                className="drawing-rack__free"
                style={{ top, height }}
                aria-hidden="true"
              />
            );
          })}

          {dropPreview != null && (
            <div
              className={
                dropPreview.valid ? 'drawing-rack__drop-preview' : 'drawing-rack__drop-preview drawing-rack__drop-preview--invalid'
              }
              style={{
                top: (rack.heightU - dropPreview.toU) * U_PX,
                height: (dropPreview.toU - dropPreview.fromU + 1) * U_PX,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export const RACK_NODE_WIDTH = RAIL_PX * 2 + RACK_INNER_PX;
export function rackNodeHeight(rack: Pick<RackView, 'heightU'>): number {
  return RACK_HEADER_PX + rack.heightU * U_PX;
}
