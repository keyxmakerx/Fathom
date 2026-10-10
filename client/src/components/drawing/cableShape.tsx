import { useEffect, useRef, useState } from 'react';

import { cableLeadCubic, leadsFor, type Leads, type PortPoint } from './cableEnds';
import {
  cubicPoints,
  fadeTips,
  laneOffsetPx,
  offsetCubic,
  polylinePath,
  squarePoints,
  swayAt,
  swayKick,
  SWAY_SETTLE_MS,
  tiedPoints,
  type Pt,
  type TiedRoute,
} from './cableRoute';
import type { CableStyle } from './cableStyle';
import type { CableKind } from './contract';
import { cableSagCubic, cubicPath } from './geometry';
import { prefersReducedMotion } from './motion';

const ZERO: Pt = { x: 0, y: 0 };

/** Physics: the slack lags when a device moves its ends, swings back past rest and settles.
 * Re-renders only this cable, only while it swings; never under reduced motion. */
export function useCableSway(enabled: boolean, ax: number, ay: number, bx: number, by: number): Pt {
  const prev = useRef<{ ax: number; ay: number; bx: number; by: number } | null>(null);
  const kick = useRef<{ amp: Pt; at: number } | null>(null);
  const frame = useRef<number | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    const was = prev.current;
    prev.current = { ax, ay, bx, by };
    if (!enabled || was == null || prefersReducedMotion() || typeof requestAnimationFrame !== 'function') return;
    const moved = { x: (ax - was.ax + (bx - was.bx)) / 2, y: (ay - was.ay + (by - was.by)) / 2 };
    if (Math.abs(moved.x) < 0.5 && Math.abs(moved.y) < 0.5) return;
    const now = performance.now();
    const current = kick.current != null ? swayAt(kick.current.amp, now - kick.current.at) : ZERO;
    kick.current = { amp: swayKick(current, moved), at: now };
    if (frame.current != null) return;
    const loop = () => {
      const k = kick.current;
      if (k == null || performance.now() - k.at >= SWAY_SETTLE_MS) {
        kick.current = null;
        frame.current = null;
      } else {
        frame.current = requestAnimationFrame(loop);
      }
      setTick((t) => t + 1);
    };
    frame.current = requestAnimationFrame(loop);
  }, [enabled, ax, ay, bx, by]);
  useEffect(
    () => () => {
      if (frame.current != null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  const k = kick.current;
  return enabled && k != null ? swayAt(k.amp, performance.now() - k.at) : ZERO;
}

export interface CableShapeInput {
  style: CableStyle;
  id: string;
  kind: CableKind;
  ends: [PortPoint | null, PortPoint | null] | undefined;
  source: Pt;
  target: Pt;
  tied?: TiedRoute;
  sway?: Pt;
}

export interface CableShapeResult {
  d: string;
  points: Pt[];
  leads: Leads | null;
}

/** The line one cable (or band) draws in this person's style. */
export function cableShape({ style, id, kind, ends, source, target, tied, sway }: CableShapeInput): CableShapeResult {
  const leads = ends != null && (ends[0] != null || ends[1] != null) ? leadsFor(ends[0], ends[1], source, target) : null;
  if (style === 'physics') {
    const base = leads != null ? cableLeadCubic(leads, kind) : cableSagCubic(source.x, source.y, target.x, target.y, kind);
    const c = offsetCubic(base, sway ?? ZERO);
    return { d: cubicPath(c), points: cubicPoints(c), leads };
  }
  const square = leads ?? leadsFor(null, null, source, target);
  const points = style === 'tied' && tied != null ? tiedPoints(square, tied) : squarePoints(square, laneOffsetPx(id, kind));
  return { d: polylinePath(points), points, leads };
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
