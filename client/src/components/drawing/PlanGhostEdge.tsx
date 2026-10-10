import type { Edge, EdgeProps } from '@xyflow/react';

import { cableLeadPath, leadsFor } from './cableEnds';
import { cableSagPath } from './geometry';
import { TONE_COLOUR, type PlanEdgeMark, type PlanGhostData } from './plansMarks';
import './plans-canvas.css';

export type PlanGhostEdgeType = Edge<PlanGhostData, 'planGhost'>;

/** The word on a mark on a cable, drawn at `x, y`: a small box in the stage colour. Never takes the pointer. */
export function PlanEdgeTag({ x, y, mark }: { x: number; y: number; mark: PlanEdgeMark }) {
  const w = Math.round(mark.word.length * 5.4 + 10);
  const filled = mark.tone === 'done';
  const colour = TONE_COLOUR[mark.tone];
  return (
    <g className="plan-edge-tag" pointerEvents="none" transform={`translate(${x - w / 2}, ${y - 6})`}>
      <rect width={w} height={12} className="plan-edge-tag__box" style={{ fill: filled ? colour : 'var(--page)', stroke: colour }} />
      <text x={5} y={9} className="plan-edge-tag__word" style={{ fill: filled ? 'var(--page)' : colour }}>
        {mark.word}
      </text>
    </g>
  );
}

/** A cable the plan adds (or a suggestion, with no word and so no tag), drawn between the two port plates; it is
 * not in the document and cannot be hit. */
export function PlanGhostEdge({ sourceX, sourceY, targetX, targetY, data }: EdgeProps<PlanGhostEdgeType>) {
  if (!data) return null;
  const { planMark, ends } = data;
  const leads = ends != null ? leadsFor(ends[0], ends[1], { x: sourceX, y: sourceY }, { x: targetX, y: targetY }) : null;
  const d = leads != null ? cableLeadPath(leads) : cableSagPath(sourceX, sourceY, targetX, targetY, 'copper');
  const colour = TONE_COLOUR[planMark.tone];
  const midX = leads != null ? (leads.a.x + leads.b.x) / 2 : (sourceX + targetX) / 2;
  const midY = leads != null ? (leads.a.y + leads.b.y) / 2 : (sourceY + targetY) / 2;
  return (
    <g className={`plan-ghost plan-ghost--${planMark.tone}`} data-plan-ghost pointerEvents="none">
      <path d={d} className="plan-ghost__wash" style={{ stroke: colour }} />
      <path d={d} className="plan-ghost__line" style={{ stroke: colour, strokeDasharray: planMark.dashed ? '5 3' : undefined }} />
      {planMark.word !== '' && <PlanEdgeTag x={midX} y={midY} mark={planMark} />}
    </g>
  );
}
