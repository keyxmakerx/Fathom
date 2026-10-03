import type { MouseEvent } from 'react';
import { EdgeLabelRenderer, useStore } from '@xyflow/react';

import { axisToward, STUB_RUN_PX, stubRun, type Pt, type StubEnd } from './stubs';

/** The two stub runs of one cable (or bundle) and their tags. Each end fades
 * out along its run; the tag at its tip names the far end and pans to it. */
export function StubTags({
  id,
  colour,
  width,
  points,
  stubs,
  dirs,
  onPanTo,
  onHover,
}: {
  id: string;
  colour: string;
  width: string;
  points: [Pt, Pt];
  stubs: [StubEnd, StubEnd];
  /** Each end's own leaving direction; defaults to square toward the other end. */
  dirs?: [{ dx: number; dy: number }, { dx: number; dy: number }];
  onPanTo: (chassisId: string) => void;
  /** Hovering a tag asks for the whole cable to draw. */
  onHover?: (on: boolean) => void;
}) {
  // Tags keep a constant on-screen size; bucketed so only a real zoom change re-renders.
  const zoom = useStore((st) => Math.max(0.05, Math.round(st.transform[2] * 20) / 20));
  const runs = points.map((p, i) => {
    const d = dirs?.[i] ?? axisToward(p, points[1 - i]!);
    // A vertical stub runs on past its rack's frame edge so the tag sits in the gap, clear of the frame and any header.
    const f = stubs[i]!.frame;
    const clearY = f == null ? undefined : d.dy > 0 ? f.bottom : f.top;
    const past = clearY != null && d.dx === 0 && (clearY - p.y) * d.dy >= 0 ? Math.abs(clearY - p.y) + 6 / zoom : 0;
    return { from: p, ...stubRun(p, d.dx, d.dy, Math.max(STUB_RUN_PX, past)), d2: d };
  });
  return (
    <>
      <defs>
        {runs.map((r, i) => (
          <linearGradient key={i} id={`stub-fade-${id}-${i}`} gradientUnits="userSpaceOnUse" x1={r.from.x} y1={r.from.y} x2={r.end.x} y2={r.end.y}>
            <stop offset="0" stopColor={colour} />
            <stop offset="1" stopColor={colour} stopOpacity="0" />
          </linearGradient>
        ))}
      </defs>
      {runs.map((r, i) => (
        <path key={i} d={r.d} fill="none" stroke={`url(#stub-fade-${id}-${i})`} strokeWidth={width} strokeLinecap="butt" className="drawing-stub__run" />
      ))}
      <EdgeLabelRenderer>
        {runs.map((r, i) => (
          <button
            key={i}
            type="button"
            className="drawing-stub__tag nodrag nopan"
            style={{ fontSize: `${12 / zoom}px`, transform: `translate(${r.d2.dx > 0 ? '0%' : r.d2.dx < 0 ? '-100%' : '-50%'}, ${r.d2.dy > 0 ? '0%' : r.d2.dy < 0 ? '-100%' : '-50%'}) translate(${r.end.x}px, ${r.end.y}px)` }}
            onMouseEnter={() => onHover?.(true)}
            onMouseLeave={() => onHover?.(false)}
            onClick={(event: MouseEvent) => {
              event.stopPropagation();
              onPanTo(stubs[i]!.panTo);
            }}
          >
            {stubs[i]!.text}
          </button>
        ))}
      </EdgeLabelRenderer>
    </>
  );
}
