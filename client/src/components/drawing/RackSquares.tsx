// The squares on a rack (ADR-0060 step 7): hollow squares on the free unit above and below the
// selected racked device; a click adds a device into that unit. One component so round 6 can
// change the look without touching anything else.

import { ViewportPortal } from '@xyflow/react';
import type { MouseEvent } from 'react';

import type { RackView } from './contract';
import { RACK_HEADER_PX, RACK_INNER_PX, RAIL_PX, U_PX, uToOffsetPx } from './geometry';

export interface RackSquaresProps {
  racks: readonly RackView[];
  rackPositions: Readonly<Record<string, { x: number; y: number }>>;
  /** The selected chassis, if it is racked. */
  chassisId: string | null;
  canDraw: boolean;
  /** `screen` is the click's page position; the caller turns it into its own pane coordinates. */
  onOpen: (at: { clientX: number; clientY: number }, flow: { x: number; y: number }, rackId: string, positionU: number) => void;
}

/** The free units directly above and below a chassis, if any. */
export function squareUnits(rack: Pick<RackView, 'heightU' | 'chassis' | 'shelves'>, chassisId: string): number[] {
  const me = rack.chassis.find((c) => c.id === chassisId);
  if (!me) return [];
  const taken = new Set<number>();
  for (const item of [...rack.chassis, ...rack.shelves]) for (let u = item.positionU; u < item.positionU + item.heightU; u += 1) taken.add(u);
  return [me.positionU + me.heightU, me.positionU - 1].filter((u) => u >= 1 && u <= rack.heightU && !taken.has(u));
}

export function RackSquares({ racks, rackPositions, chassisId, canDraw, onOpen }: RackSquaresProps) {
  if (!canDraw || chassisId === null) return null;
  const rack = racks.find((r) => r.chassis.some((c) => c.id === chassisId));
  const pos = rack ? rackPositions[rack.id] : undefined;
  if (!rack || !pos) return null;
  const centreX = pos.x + RAIL_PX + RACK_INNER_PX / 2;
  return (
    <ViewportPortal>
      {squareUnits(rack, chassisId).map((u) => {
        const x = centreX;
        const y = pos.y + RACK_HEADER_PX + uToOffsetPx(rack.heightU, u, 1) + U_PX / 2;
        return (
          <button
            key={u}
            type="button"
            className="free-square rack-square nodrag nopan"
            style={{ position: 'absolute', transform: `translate(calc(${x}px - 50%), calc(${y}px - 50%))`, pointerEvents: 'all' }}
            aria-label={`Add a device at U${u}`}
            title={`Add a device at U${u}`}
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              onOpen(e, { x, y }, rack.id, u);
            }}
          />
        );
      })}
    </ViewportPortal>
  );
}
