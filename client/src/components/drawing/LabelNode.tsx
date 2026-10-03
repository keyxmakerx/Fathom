import { useEffect, useRef } from 'react';
import type { Node, NodeProps } from '@xyflow/react';

import { AREA_MIN_H, AREA_MIN_W } from '../../document/freeform';
import { useGripDrag, type GripDrag } from './useGripDrag';

/** A text label, or an area: a labelled rectangle that groups things by meaning. */
export interface LabelNodeData extends Record<string, unknown> {
  text: string;
  form: 'text' | 'area';
  w: number;
  h: number;
  editing: boolean;
  /** Show the resize grip (an area, selected, by a person who can draw). */
  grip: boolean;
  onEdit: (text: string | null) => void;
  onResize: (w: number, h: number, final: boolean) => void;
}

export type LabelNodeType = Node<LabelNodeData, 'label'>;

function TextEditor({ data }: { data: LabelNodeData }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="free-label__input nodrag nopan"
      defaultValue={data.text}
      aria-label="Label text"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') data.onEdit(e.currentTarget.value);
        if (e.key === 'Escape') data.onEdit(null);
      }}
      onBlur={(e) => data.onEdit(e.currentTarget.value)}
    />
  );
}

function AreaGrip({ data }: { data: LabelNodeData }) {
  const start = useRef({ w: data.w, h: data.h });
  const size = (d: GripDrag) => ({ w: Math.max(AREA_MIN_W, start.current.w + d.dx), h: Math.max(AREA_MIN_H, start.current.h + d.dy) });
  const onDown = useGripDrag({
    onMove: (d) => {
      const s = size(d);
      data.onResize(s.w, s.h, false);
    },
    onEnd: (d, cancelled) => {
      const s = cancelled ? start.current : size(d);
      data.onResize(s.w, s.h, d.moved && !cancelled);
    },
  });
  return (
    <button
      type="button"
      className="free-square free-square--grip nodrag nopan"
      aria-label="Resize the area"
      onPointerDown={(e) => {
        start.current = { w: data.w, h: data.h };
        onDown(e);
      }}
    />
  );
}

export function LabelNode({ data, selected }: NodeProps<LabelNodeType>) {
  const edit = data.editing ? <TextEditor data={data} /> : null;
  if (data.form === 'area') {
    return (
      <div className={selected ? 'free-area free-area--selected' : 'free-area'} style={{ width: data.w, height: data.h }}>
        <div className="free-area__title">{edit ?? <span>{data.text || 'Area'}</span>}</div>
        {data.grip && <AreaGrip data={data} />}
      </div>
    );
  }
  return <div className={selected ? 'free-label free-label--selected' : 'free-label'}>{edit ?? (data.text || 'Label')}</div>;
}
