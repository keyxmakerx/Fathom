import type { Edge, EdgeProps } from '@xyflow/react';

import type { Bundle } from './bundles';
import { SHEATH_VAR } from './sheath';
import { cableLeadPath, leadsFor, type PortPoint } from './cableEnds';
import { cableSagPath } from './geometry';
import { useLive } from './liveStore';
import { PlanEdgeTag } from './PlanGhostEdge';
import { TONE_COLOUR, type PlanEdgeMark } from './plansMarks';

export interface BundleEdgeData extends Record<string, unknown> {
  bundle: Bundle;
  /** Set while an open plan touches a cable in this band: its stage colour and tag. */
  planMark?: PlanEdgeMark;
  /** True while this bundle is fanned open (`Drawing.tsx`'s own hover
   * state) — the band itself draws invisible (its members draw instead,
   * each a real `CableEdge`) but keeps its generous hit path mounted, so
   * leaving the same region it occupied while collapsed is what folds the
   * fan back — UI-SPEC #2: "then it folds back on leave." */
  fanned: boolean;
  onFan: (key: string | null) => void;
  /** Where the band meets each device: the mean of its members' ports there. */
  ends?: [PortPoint | null, PortPoint | null];
}

export type BundleEdgeType = Edge<BundleEdgeData, 'bundle'>;

/** UI-SPEC "Keeping it readable at forty cables" #1: "one band whose width
 * grows with the count." A single member never reaches `BundleEdge` at all
 * (`Drawing.tsx` draws a bundle of one as a plain `CableEdge`), so the
 * smallest band here is already a two-cable band. */
const BAND_BASE_WIDTH_PX = 4;
const BAND_WIDTH_PER_MEMBER_PX = 1.4;

/**
 * The collapsed band — `docs/UI-SPEC.md` #1: "cables sharing both ends draw
 * as one band whose width grows with the count and carries a `×n` badge."
 * The badge is ink text in a hairline box (never a sheath colour: a band
 * mixes sheaths, so nothing here pretends to be one cable's colour) —
 * `Main.dc.html`'s own reading of "the only way a risk colour appears" (a
 * different UI-SPEC line, about `single-fed`) generalised the same way: a
 * badge's box is always ink-on-page, never a sheath, never a risk colour.
 */
export function BundleEdge({ sourceX, sourceY, targetX, targetY, data }: EdgeProps<BundleEdgeType>) {
  // Read live rather than through `data`, so a hover elsewhere never
  // rebuilds this bundle's edge — ahead of the `!data` guard so the hook always runs.
  const dimmed = useLive((s) => (data ? s.litCableId != null && !data.bundle.members.some((m) => s.litCableIdSet.has(m.id)) : false));
  if (!data) return null;
  const { bundle, fanned, onFan } = data;
  const leads = data.ends != null && (data.ends[0] != null || data.ends[1] != null) ? leadsFor(data.ends[0], data.ends[1], { x: sourceX, y: sourceY }, { x: targetX, y: targetY }) : null;
  const d = leads != null ? cableLeadPath(leads, bundle.kind) : cableSagPath(sourceX, sourceY, targetX, targetY, bundle.kind);
  const count = bundle.members.length;
  // One shared sheath draws the band in it (Zoom B); a mix draws grey.
  const sheaths = new Set(bundle.members.map((m) => m.sheath ?? 'grey'));
  const bandColour = sheaths.size === 1 ? SHEATH_VAR[[...sheaths][0]!] : 'var(--sheath-grey)';
  const width = BAND_BASE_WIDTH_PX + BAND_WIDTH_PER_MEMBER_PX * (count - 1);
  const midX = leads != null ? (leads.a.x + leads.b.x) / 2 : (sourceX + targetX) / 2;
  const midY = leads != null ? (leads.a.y + leads.b.y) / 2 : (sourceY + targetY) / 2;
  const opacity = dimmed ? 'var(--phantom)' : 1;

  return (
    <g
      className="drawing-bundle"
      data-bundle-key={bundle.key}
      style={{ opacity, cursor: 'pointer' }}
      onMouseEnter={() => onFan(bundle.key)}
      onMouseLeave={() => onFan(null)}
    >
      {!fanned && (
        <>
          {data.planMark != null && (
            <path d={d} fill="none" stroke={TONE_COLOUR[data.planMark.tone]} strokeWidth={width + 6} strokeLinecap="round" className="plan-mark__wash" />
          )}
          <path d={d} fill="none" stroke={bandColour} strokeWidth={width} strokeLinecap="round" className="drawing-bundle__band" />
          {data.planMark != null && <PlanEdgeTag x={midX} y={midY - 16} mark={data.planMark} />}
          <g transform={`translate(${midX}, ${midY})`} className="drawing-bundle__badge">
            <rect x={-11} y={-7} width={22} height={14} className="drawing-bundle__badge-box" />
            <text textAnchor="middle" dominantBaseline="central" className="drawing-bundle__badge-text">
              &times;{count}
            </text>
          </g>
        </>
      )}
      {/* Generous invisible hit path, mounted whether fanned or not — this
          is what `onMouseEnter`/`onMouseLeave` above actually listen on, so
          the fan opens and folds off the same region regardless of which
          visual (band or members) currently occupies it. */}
      <path d={d} fill="none" stroke="transparent" strokeWidth={Math.max(width + 12, 18)} pointerEvents="stroke" />
    </g>
  );
}
