import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Node, NodeProps } from '@xyflow/react';

import type { CableView } from './contract';
import type { LooseState } from './missingLinks';
import {
  circleCentre,
  fadeStops,
  LOOSE_NODE_W,
  LOOSE_RUN_PX,
  LOOSE_SOLID_PX,
  looseColumn,
  MISSING_CIRCLE_R,
  MISSING_MARK_PX,
  MISSING_MARK_CLASS,
  stretchDashes,
  stretchRange,
} from './looseEnd';
import { prefersReducedMotion } from './motion';
import { SHEATH_VAR } from './sheath';
import '../../styles/missing-links.css';

/** What hovering a loose end says. */
export const FAR_END_UNKNOWN = 'Far end unknown';
export const NEEDS_FINISHING = 'Needs finishing';

export interface LooseCableNodeData extends Record<string, unknown> {
  cable: CableView;
  state: LooseState;
  /** +1 the line leaves its port downward, -1 upward. */
  dir: 1 | -1;
  selected: boolean;
  onSelect: (cableId: string) => void;
}

export type LooseCableNodeType = Node<LooseCableNodeData, 'looseCable'>;

export const looseCableNodeId = (cableId: string): string => `loose:${cableId}`;

const STROKE_WIDTH: Record<CableView['kind'], string> = {
  copper: 'var(--cable-copper)',
  fibre: 'var(--cable-fibre)',
  power: 'var(--cable-power)',
};

/**
 * A cable with only one end connected: the line leaves its port and stops short, in one of two
 * looks. Unknown (the default) fades out toward where the far end would be, with no motion; it says
 * "Far end unknown" on hover. Needs finishing (a person marked it) turns the last stretch into
 * slanted amber dashes crawling toward the far end, a circle in the middle of the gap holding a ?
 * that swings like a bell. Both animations stop under `prefers-reduced-motion` (the CSS says so,
 * and `still` says so in the markup).
 */
export function LooseCableNode({ data }: NodeProps<LooseCableNodeType>) {
  const { cable, state, dir, selected, onSelect } = data;
  const col = looseColumn(dir);
  const needs = state === 'needs-finishing';
  const still = prefersReducedMotion();
  const colour = SHEATH_VAR[cable.sheath ?? 'grey'];
  const width = STROKE_WIDTH[cable.kind];
  const gid = `loose-fade-${cable.id}`;
  const cid = `loose-clip-${cable.id}`;
  const stretch = stretchRange(dir);
  const solidEnd = col.along(LOOSE_SOLID_PX);
  const centre = circleCentre(dir);
  const label = needs ? NEEDS_FINISHING : FAR_END_UNKNOWN;

  function handleClick(event: ReactMouseEvent) {
    event.stopPropagation();
    onSelect(cable.id);
  }

  return (
    <svg
      className={['drawing-loose', needs ? 'drawing-loose--needs' : 'drawing-loose--unknown', still ? 'drawing-loose--still' : '', selected ? 'drawing-loose--selected' : ''].filter(Boolean).join(' ')}
      width={LOOSE_NODE_W}
      height={LOOSE_RUN_PX}
      viewBox={`0 0 ${LOOSE_NODE_W} ${LOOSE_RUN_PX}`}
      overflow="visible"
      role="img"
      aria-label={`Cable with one end connected: ${label.toLowerCase()}`}
      data-testid="loose-cable"
      data-cable-id={cable.id}
      data-loose-state={state}
      style={{ pointerEvents: 'none' }}
    >
      <defs>
        {needs ? (
          <clipPath id={cid}>
            <rect x={0} y={stretch.top} width={LOOSE_NODE_W} height={stretch.bottom - stretch.top} />
          </clipPath>
        ) : (
          <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1={col.x} y1={col.portY} x2={col.x} y2={col.tipY}>
            {fadeStops().map((s) => (
              <stop key={s.offset} offset={s.offset} stopColor={colour} stopOpacity={s.opacity} />
            ))}
          </linearGradient>
        )}
      </defs>
      <g className="drawing-loose__cable" data-cable-id={cable.id}>
        {selected && (
          <line x1={col.x} y1={col.portY} x2={col.x} y2={col.tipY} stroke="var(--hairline)" strokeWidth="var(--cable-halo)" strokeLinecap="round" opacity={0.6} />
        )}
        {needs ? (
          <>
            <line className="drawing-loose__solid" x1={col.x} y1={col.portY} x2={col.x} y2={solidEnd} stroke={colour} strokeWidth={width} strokeLinecap="round" />
            <g clipPath={`url(#${cid})`}>
              <g className={`drawing-loose__dashes drawing-loose__dashes--${dir === 1 ? 'down' : 'up'}`} data-testid="loose-dashes">
                {stretchDashes(dir).map((points) => (
                  <polygon key={points} points={points} fill="var(--caution)" />
                ))}
              </g>
            </g>
            <circle className="drawing-loose__circle" cx={centre.x} cy={centre.y} r={MISSING_CIRCLE_R} fill="var(--caution-wash)" stroke="var(--caution)" strokeWidth={1.5} />
            <g className={MISSING_MARK_CLASS} data-testid="missing-mark" transform={`translate(${centre.x} ${centre.y})`}>
              <g className="missing-mark__swing">
                <text className="missing-mark__glyph" fontSize={MISSING_MARK_PX} x={0} y={0} textAnchor="middle" dominantBaseline="central" aria-hidden="true">
                  ?
                </text>
              </g>
            </g>
          </>
        ) : (
          <line className="drawing-loose__fade" x1={col.x} y1={col.portY} x2={col.x} y2={col.tipY} stroke={`url(#${gid})`} strokeWidth={width} strokeLinecap="round" />
        )}
      </g>
      {/* A fatter, invisible stroke widens the click and hover target, and carries the hover words. */}
      <line
        x1={col.x}
        y1={col.portY}
        x2={col.x}
        y2={col.tipY}
        stroke="transparent"
        strokeWidth={14}
        pointerEvents="stroke"
        style={{ cursor: 'pointer' }}
        className="nodrag nopan"
        onClick={handleClick}
      >
        <title>{label}</title>
      </line>
    </svg>
  );
}
