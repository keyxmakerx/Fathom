import type { Edge, EdgeProps } from '@xyflow/react';

/** A line between two boxes that needs no ports (ADR-0060 decision 2). */
export interface LineEdgeData extends Record<string, unknown> {
  label: string | null;
  selected: boolean;
  onSelect: () => void;
}

export type LineEdgeType = Edge<LineEdgeData, 'line'>;

export function LineEdge({ sourceX, sourceY, targetX, targetY, data }: EdgeProps<LineEdgeType>) {
  const d = `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
  const mid = { x: (sourceX + targetX) / 2, y: (sourceY + targetY) / 2 };
  const selected = data?.selected === true;
  return (
    <g className={selected ? 'free-line free-line--selected' : 'free-line'}>
      <path d={d} className="free-line__hit" onClick={(e) => (e.stopPropagation(), data?.onSelect())} />
      <path d={d} className="free-line__ink" />
      {data?.label ? (
        <text x={mid.x} y={mid.y} className="free-line__label" textAnchor="middle" dominantBaseline="central">
          {data.label}
        </text>
      ) : null}
    </g>
  );
}
