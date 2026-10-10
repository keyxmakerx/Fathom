import { useRef } from 'react';
import type { Node, NodeProps } from '@xyflow/react';

import { AREA_MIN_H, AREA_MIN_W } from '../../document/freeform';
import { NoteCard } from './NoteCard';
import { useEditFocus } from './useEditFocus';
import { useGripDrag, type GripDrag } from './useGripDrag';

/** A text label, an area (a labelled rectangle that groups things by meaning), or a note pinned to the canvas. */
export interface LabelNodeData extends Record<string, unknown> {
  text: string;
  form: 'text' | 'area' | 'note';
  /** A note's author and time, when on record. */
  author?: { actor: string; at: number };
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
  const onBlur = useEditFocus(ref, (value) => data.onEdit(value));
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
      onBlur={onBlur}
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
  if (data.form === 'note') return <NoteCard text={data.text} author={data.author} editing={data.editing} selected={selected === true} onEdit={data.onEdit} />;
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
