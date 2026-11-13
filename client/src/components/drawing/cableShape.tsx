import { useEffect, useRef, useState } from 'react';

import { leadsFor, type Leads, type PortPoint } from './cableEnds';
import {
  fadeTips,
  laneOffsetPx,
  roundedPath,
  squarePoints,
  throughTies,
  tiedPoints,
  type Pt,
  type TiedRoute,
  type Waypoint,
} from './cableRoute';
import type { CableStyle } from './cableStyle';
import type { CableKind } from './contract';
import { CABLE_SLACK, cableSwings, hangCable } from './cablePhysics';
import { RACK_INNER_PX } from './geometry';
import { prefersReducedMotion } from './motion';

const ZERO: Pt = { x: 0, y: 0 };

/** Physics: the slack lags when a device moves its ends, swings back past rest and settles.
 * Re-renders only this cable, only while it swings; never under reduced motion. `id` lets a cable
 * whose edge React Flow remakes in the moment its device lands keep swinging (`CableSwings`). */
export function useCableSway(id: string, enabled: boolean, ax: number, ay: number, bx: number, by: number): Pt {
  const frame = useRef<number | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    const now = performance.now();
    const moving = enabled && !prefersReducedMotion() && typeof requestAnimationFrame === 'function';
    cableSwings.see(id, { ax, ay, bx, by }, now, moving);
    if (!moving || !cableSwings.swinging(id, now) || frame.current != null) return;
    const loop = () => {
      if (cableSwings.swinging(id, performance.now())) frame.current = requestAnimationFrame(loop);
      else frame.current = null;
      setTick((t) => t + 1);
    };
    frame.current = requestAnimationFrame(loop);
  }, [id, enabled, ax, ay, bx, by]);
  useEffect(
    () => () => {
      if (frame.current != null) cancelAnimationFrame(frame.current);
      frame.current = null;
      cableSwings.gone(id, performance.now());
    },
    [id],
  );
  return enabled ? cableSwings.offset(id, performance.now()) : ZERO;
}

export interface CableShapeInput {
  style: CableStyle;
  id: string;
  kind: CableKind;
  ends: [PortPoint | null, PortPoint | null] | undefined;
  source: Pt;
  target: Pt;
  tied?: TiedRoute;
  /** Cable-tied: real ties on runs this cable passes through, in order. */
  waypoints?: readonly Waypoint[];
  sway?: Pt;
}

export interface CableShapeResult {
  d: string;
  points: Pt[];
  leads: Leads | null;
}

/** The line one cable (or band) draws in this person's style. */
export function cableShape({ style, id, kind, ends, source, target, tied, waypoints, sway }: CableShapeInput): CableShapeResult {
  const hasBox = ends != null && (ends[0] != null || ends[1] != null);
  if (style === 'physics') {
    // Within one rack's width (a shelf down to a switch, one switch to the next), each plug points at
    // the other end whatever row its port is in, so the cable drops from one into the other instead of
    // leaving a bottom-row port downward and curling back up. Runs between places keep their rows.
    const near = (box: PortPoint | null, fb: Pt) => (box != null ? box.x + box.w / 2 : fb.x);
    const inOneRack = hasBox && Math.abs(near(ends[0], source) - near(ends[1], target)) <= RACK_INNER_PX;
    const leads = hasBox ? leadsFor(ends[0], ends[1], source, target, !inOneRack) : null;
    // A real cable hangs between its ports under gravity (`cablePhysics.ts`). Power carries a little
    // more slack, so a power lead and a data lead between the same two places never draw as one line.
    const hung = hangCable({
      a: leads != null ? leads.a : source,
      b: leads != null ? leads.b : target,
      slack: kind === 'power' ? CABLE_SLACK + 0.03 : CABLE_SLACK,
      sway,
      stiffDrop: inOneRack,
    });
    return { d: hung.d, points: hung.points, leads };
  }
  const leads = hasBox ? leadsFor(ends[0], ends[1], source, target) : null;
  const square = leads ?? leadsFor(null, null, source, target);
  const points =
    style === 'tied' && waypoints != null && waypoints.length > 0
      ? throughTies(square, waypoints)
      : style === 'tied' && tied != null
        ? tiedPoints(square, tied)
        : squarePoints(square, laneOffsetPx(id, kind));
  return { d: roundedPath(points), points, leads };
}

/** Faded: about an inch of the line shows at each end and fades out along it toward the middle;
 * a ghost of the rest stays just visible. The caller draws the whole line instead while it is
 * revealed, with no transition (the reveal is instant). */
export function FadedTips({
  id,
  d,
  points,
  colour,
  width,
}: {
  id: string;
  d: string;
  points: readonly Pt[];
  colour: string;
  width: string;
}) {
  const tips = fadeTips(points);
  if (tips == null) return <path d={d} fill="none" stroke={colour} strokeWidth={width} strokeLinecap="round" />;
  const gid = (i: number) => `cable-fade-${id}-${i}`;
  return (
    <>
      <defs>
        {[0, 1].map((i) => (
          <linearGradient
            key={i}
            id={gid(i)}
            gradientUnits="userSpaceOnUse"
            x1={tips.from[i]!.x}
            y1={tips.from[i]!.y}
            x2={tips.to[i]!.x}
            y2={tips.to[i]!.y}
          >
            <stop offset="0" stopColor={colour} />
            <stop offset="1" stopColor={colour} stopOpacity="0" />
          </linearGradient>
        ))}
      </defs>
      <path d={d} fill="none" stroke={colour} strokeWidth={width} className="drawing-cable__ghost" />
      <path d={d} fill="none" stroke={`url(#${gid(0)})`} strokeWidth={width} strokeDasharray={`${tips.tip} ${tips.total}`} />
      <path
        d={d}
        fill="none"
        stroke={`url(#${gid(1)})`}
        strokeWidth={width}
        strokeDasharray={`0 ${tips.total - tips.tip} ${tips.tip} ${tips.total}`}
      />
    </>
  );
}
