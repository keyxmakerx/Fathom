// A note pinned to the canvas (schema 0.19, `Label.form` = note): a small card for teammates and
// for later. Square, hairline, a surface tint, the words wrapping. Edited in place like a label:
// Enter keeps it, Shift Enter starts a new line, Esc leaves it as it was.
import { useEffect, useRef } from 'react';

import '../../styles/notes.css';

export interface NoteCardProps {
  text: string;
  editing: boolean;
  selected: boolean;
  onEdit: (text: string | null) => void;
}

function NoteEditor({ text, onEdit }: { text: string; onEdit: (text: string | null) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onEdit(value === null ? null : value.trim() === '' ? text : value);
  };
  return (
    <textarea
      ref={ref}
      className="free-note__input nodrag nopan nowheel"
      defaultValue={text}
      aria-label="Note text"
      rows={Math.min(8, Math.max(2, text.split('\n').length + 1))}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          finish(e.currentTarget.value);
        }
        if (e.key === 'Escape') finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

export function NoteCard({ text, editing, selected, onEdit }: NoteCardProps) {
  return (
    <div className={'free-note' + (selected ? ' free-note--selected' : '') + (editing ? ' free-note--editing' : '')} data-testid="free-note">
      <span className="free-note__tag" aria-hidden="true">
        Note
      </span>
      {editing ? <NoteEditor text={text} onEdit={onEdit} /> : <p className="free-note__text">{text || 'Note'}</p>}
    </div>
  );
}
