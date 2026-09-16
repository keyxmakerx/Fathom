import type { Node, NodeProps } from '@xyflow/react';

import type { RackView } from './contract';
import { RACK_HEADER_PX, RACK_INNER_PX, RAIL_PX, U_PX, sortFreeRuns } from './geometry';

export interface RackNodeData extends Record<string, unknown> {
  rack: RackView;
  selected: boolean;
  /** Set while a palette item or a chassis is being dragged over this rack,
   * with whether the run it would land on is free. `null` when nothing is
   * being dragged over it. */
  dropPreview: { fromU: number; toU: number; valid: boolean } | null;
  /** True for the ~180ms after a drop this rack refused, for the shake. */
  shaking: boolean;
}

export type RackNodeType = Node<RackNodeData, 'rack'>;

/** Rails, U numbers, hatched free runs — drawn exactly as `design/shell/Main.dc.html`
 * and `design/shell/Lenses.dc.html` draw them. Chassis are not drawn here:
 * they are sibling React Flow nodes positioned to align with this rack's
 * frame (`Drawing.tsx`), so a chassis can be dragged from one rack's frame
 * to another's without this node re-rendering. */
export function RackNode({ data }: NodeProps<RackNodeType>) {
  const { rack, selected, dropPreview, shaking } = data;
  const frameHeight = rack.heightU * U_PX;
  const usedU = rack.chassis.reduce((sum, c) => sum + c.heightU, 0);
  const runs = sortFreeRuns(rack.freeRuns);
  const width = RAIL_PX * 2 + RACK_INNER_PX;

  return (
    <div
      className={['drawing-rack', selected ? 'drawing-rack--selected' : '', shaking ? 'drawing-rack--shake' : '']
        .filter(Boolean)
        .join(' ')}
      style={{ width }}
    >
      <div className="drawing-rack__label">
        {rack.label} &middot; {rack.heightU}U &middot; {usedU} used
      </div>
      <div className="drawing-rack__frame" style={{ height: frameHeight }}>
        <div className="drawing-rack__rail drawing-rack__rail--left" style={{ width: RAIL_PX }} />
        <div className="drawing-rack__rail drawing-rack__rail--right" style={{ width: RAIL_PX }} />

        <div className="drawing-rack__u-numbers drawing-rack__u-numbers--left" style={{ width: RAIL_PX }}>
          {Array.from({ length: rack.heightU }, (_, i) => rack.heightU - i).map((u) => (
            <div key={u} className="drawing-rack__u-number" style={{ height: U_PX }}>
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
