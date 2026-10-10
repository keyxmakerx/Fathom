import { Handle, Position } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';

import { CheckBadge } from '../checks/CheckBadge';
import { BOX_H, BOX_W, roleCode, type Side } from './freeLayout';
import { EditableName } from './NameEdit';
import { useGripDrag, type GripDrag } from './useGripDrag';

/** ADR-0060 step 7: a box with no rack, no model yet. A selected one shows a hollow square on
 * each edge, the same shape as a free port: drag one to draw a line, click one to add a box. */
export interface FreeBoxNodeData extends Record<string, unknown> {
  name: string;
  role: string | null;
  /** Show the four edge squares (one box selected, and a person who can draw). */
  squares: boolean;
  onSquare: (side: Side, drag: GripDrag, cancelled: boolean) => void;
  onSquareMove: (side: Side, drag: GripDrag) => void;
}

export type FreeBoxNodeType = Node<FreeBoxNodeData, 'freeBox'>;

const SIDES: readonly { side: Side; position: Position }[] = [
  { side: 't', position: Position.Top },
  { side: 'r', position: Position.Right },
  { side: 'b', position: Position.Bottom },
  { side: 'l', position: Position.Left },
];

function EdgeSquare({ side, data }: { side: Side; data: FreeBoxNodeData }) {
  const onDown = useGripDrag({
    onMove: (drag) => data.onSquareMove(side, drag),
    onEnd: (drag, cancelled) => data.onSquare(side, drag, cancelled),
  });
  return (
    <button
      type="button"
      className={`free-square free-square--${side} nodrag nopan`}
      aria-label={`Draw a line or add a box from the ${{ t: 'top', r: 'right', b: 'bottom', l: 'left' }[side]} edge`}
      title="Drag to draw a line. Click to add a box."
      onPointerDown={onDown}
    />
  );
}

export function FreeBoxNode({ id, data, selected }: NodeProps<FreeBoxNodeType>) {
  return (
    <div className={selected ? 'free-box free-box--selected' : 'free-box'} style={{ width: BOX_W, height: BOX_H }}>
      <CheckBadge id={id.replace(/^free:/, '')} />
      <EditableName target={{ kind: 'chassis', id: id.replace(/^free:/, '') }} text={data.name === 'unnamed' ? '' : data.name} className="free-box__name">
        {data.name}
      </EditableName>
      <span className="free-box__code">{roleCode(data.role)}</span>
      {SIDES.map(({ side, position }) => (
        <Handle key={side} id={side} type="source" position={position} isConnectable={false} className="free-handle" />
      ))}
      {data.squares && SIDES.map(({ side }) => <EdgeSquare key={side} side={side} data={data} />)}
    </div>
  );
}
