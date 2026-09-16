import { Handle, Position, useViewport, type Node, type NodeProps } from '@xyflow/react';

import { C14 } from '../ports';
import type { Facing } from './faces';
import type { ChassisView, RackView } from './contract';
import { RACK_HEADER_PX, RACK_INNER_PX, RAIL_PX, U_PX, counterScaledFontPx, sortFreeRuns } from './geometry';

/** The rack label's and U numbers' flow-space size at the rack stop —
 * `drawing.css`'s own `--t-micro` (10px) and 8px, kept here so
 * `counterScaledFontPx` has a `basePx` to counter-scale from. */
const RACK_LABEL_BASE_PX = 10;
const U_NUMBER_BASE_PX = 8;

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
  selected: boolean;
  /** Set while a palette item or a chassis is being dragged over this rack,
   * with whether the run it would land on is free. `null` when nothing is
   * being dragged over it. */
  dropPreview: { fromU: number; toU: number; valid: boolean } | null;
  /** True for the ~180ms after a drop this rack refused, for the shake. */
  shaking: boolean;
  /** Whichever chassis are currently drawn for this rack — `faces.ts`'s own
   * `chassisToDraw` output, already resolved for the camera stop and the
   * flip — so the rail's PSU marks (UI-SPEC "Power") always match what is
   * actually on screen rather than this node re-deciding the face on its
   * own. */
  visibleChassis: readonly ChassisView[];
  /** UI-SPEC "Power": "a flip at rack scale" — which face `front | rear` in
   * the header currently shows. */
  facing: Facing;
  onFlip: () => void;
  /** UI-SPEC "Rear faces": "at the rack stop a small front | rear flip in
   * the rack header" — the faceplate stop draws both faces at once
   * (`faces.ts`) and has nothing to flip, so the control itself is hidden
   * there rather than drawn inert. */
  showFlip: boolean;
}

export type RackNodeType = Node<RackNodeData, 'rack'>;

/** One inlet's rail position: `chassis`'s own row, `index` of `count`
 * siblings on that row, centred in the left rail. Shared by the visible hex
 * mark and its `Handle` so the two never drift apart. */
function psuSlot(rack: RackView, chassis: ChassisView, index: number, count: number): { left: number; top: number } {
  const rowTop = (rack.heightU - (chassis.positionU + chassis.heightU - 1)) * U_PX;
  const rowHeight = chassis.heightU * U_PX;
  const centreX = RAIL_PX / 2 + (index - (count - 1) / 2) * PSU_HEX_GAP_PX;
  const centreY = rowTop + rowHeight / 2;
  return { left: centreX - PSU_HEX_WIDTH / 2, top: centreY - PSU_HEX_HEIGHT / 2 };
}

/** Rails, U numbers, hatched free runs — drawn exactly as `design/shell/Main.dc.html`
 * and `design/shell/Lenses.dc.html` draw them. Chassis are not drawn here:
 * they are sibling React Flow nodes positioned to align with this rack's
 * frame (`Drawing.tsx`), so a chassis can be dragged from one rack's frame
 * to another's without this node re-rendering. */
export function RackNode({ data }: NodeProps<RackNodeType>) {
  const { rack, selected, dropPreview, shaking, visibleChassis, facing, onFlip, showFlip } = data;
  const { zoom } = useViewport();
  const frameHeight = rack.heightU * U_PX;
  const usedU = rack.chassis.reduce((sum, c) => sum + c.heightU, 0);
  const runs = sortFreeRuns(rack.freeRuns);
  const width = RAIL_PX * 2 + RACK_INNER_PX;
  // UI-SPEC "Motion": one continuous camera, but the rack label and U
  // numbers must stay legible at the closet stop — `geometry.ts`'s
  // `counterScaledFontPx` pins their on-screen size to a 9px floor rather
  // than letting them shrink below it as the camera zooms out.
  const labelFontPx = counterScaledFontPx(RACK_LABEL_BASE_PX, zoom);
  const uNumberFontPx = counterScaledFontPx(U_NUMBER_BASE_PX, zoom);

  return (
    <div
      className={['drawing-rack', selected ? 'drawing-rack--selected' : '', shaking ? 'drawing-rack--shake' : '']
        .filter(Boolean)
        .join(' ')}
      style={{ width }}
    >
      <div className="drawing-rack__label" style={{ fontSize: labelFontPx }}>
        <span className="drawing-rack__label-text">
          {rack.label} &middot; {rack.heightU}U &middot; {usedU} used
        </span>
        {showFlip && (
          <span className="drawing-rack__flip nodrag">
            <button
              type="button"
              className={facing === 'front' ? 'drawing-rack__face drawing-rack__face--on' : 'drawing-rack__face'}
              onClick={(e) => {
                e.stopPropagation();
                if (facing !== 'front') onFlip();
              }}
            >
              front
            </button>
            <span aria-hidden="true"> | </span>
            <button
              type="button"
              className={facing === 'rear' ? 'drawing-rack__face drawing-rack__face--on' : 'drawing-rack__face'}
              onClick={(e) => {
                e.stopPropagation();
                if (facing !== 'rear') onFlip();
              }}
            >
              rear
            </button>
          </span>
        )}
      </div>
      <div className="drawing-rack__frame" style={{ height: frameHeight }}>
        <div className="drawing-rack__rail drawing-rack__rail--left" style={{ width: RAIL_PX }}>
          {/* UI-SPEC "Power": "Each device's PSU inlets notated on the left
              rail beside it — two hexagons for dual, filled when fed." */}
          {visibleChassis.flatMap((chassis) =>
            chassis.psuInlets.map((inlet, i) => {
              const slot = psuSlot(rack, chassis, i, chassis.psuInlets.length);
              return (
                <div
                  key={inlet.id}
                  className="drawing-rack__psu"
                  style={{ left: slot.left, top: slot.top, width: PSU_HEX_WIDTH, height: PSU_HEX_HEIGHT }}
                >
                  <C14 cabled={inlet.cable != null} scale={PSU_HEX_SCALE} title={`${chassis.hostname || 'unnamed'} PSU ${i + 1}`} />
                  <Handle
                    type="source"
                    position={Position.Left}
                    id={inlet.id}
                    className="drawing-rack__psu-handle"
                  />
                </div>
              );
            }),
          )}
        </div>
        <div className="drawing-rack__rail drawing-rack__rail--right" style={{ width: RAIL_PX }} />

        <div className="drawing-rack__u-numbers drawing-rack__u-numbers--left" style={{ width: RAIL_PX }}>
          {Array.from({ length: rack.heightU }, (_, i) => rack.heightU - i).map((u) => (
            <div key={u} className="drawing-rack__u-number" style={{ height: U_PX, fontSize: uNumberFontPx }}>
              {u}
            </div>
          ))}
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
