import type { Node, NodeProps } from '@xyflow/react';

import type { Facing } from './elevation';

/**
 * ADR-0050 §2: "the closet stop arranges racks by row... the flip is one
 * camera, never a page: per row at the closet stop." One node per row,
 * docked to the left of its band — the same `front | rear` control
 * `RackNode.tsx` already draws in a rack's own header, reused here (shared
 * `.drawing-rack__face*` classes, `drawing.css`) so the two controls read as
 * one family rather than two different widgets for the same fact.
 */
export interface RowLabelNodeData extends Record<string, unknown> {
  label: string | null;
  elevation: Facing;
  onFlip: () => void;
}

export type RowLabelNodeType = Node<RowLabelNodeData, 'rowLabel'>;

/** Session choice, like `RackNode.tsx`'s own rail-scale numbers: wide enough
 * for a short row label and the flip control beside it, no board states an
 * exact figure for a widget ADR-0050 adds this session. */
export const ROW_LABEL_WIDTH = 108;

export function RowLabelNode({ data }: NodeProps<RowLabelNodeType>) {
  const { label, elevation, onFlip } = data;
  return (
    <div className="drawing-row-label nodrag">
      <span className="drawing-row-label__text">{label ?? 'row'}</span>
      <span className="drawing-rack__flip">
        <button
          type="button"
          className={elevation === 'front' ? 'drawing-rack__face drawing-rack__face--on' : 'drawing-rack__face'}
          onClick={(e) => {
            e.stopPropagation();
            if (elevation !== 'front') onFlip();
          }}
        >
          front
        </button>
        <span aria-hidden="true"> | </span>
        <button
          type="button"
          className={elevation === 'rear' ? 'drawing-rack__face drawing-rack__face--on' : 'drawing-rack__face'}
          onClick={(e) => {
            e.stopPropagation();
            if (elevation !== 'rear') onFlip();
          }}
        >
          rear
        </button>
      </span>
    </div>
  );
}
