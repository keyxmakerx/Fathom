// A note pinned to the canvas (schema 0.19, `Label.form` = note), as the owner approved it: a card
// about 270px wide on the surface colour with a soft floating shadow, an amber top edge and a small
// amber pin at its corner, the words at body size, and under them who added it and when.
// Edited in place like a label: Enter keeps it, Shift Enter starts a new line, Esc leaves it as it was.
import { useContext, useRef } from 'react';

import { NoteAuthorsContext, noteByline } from './noteByline';
import { useEditFocus } from './useEditFocus';
import '../../styles/notes.css';

export interface NoteCardProps {
  text: string;
  author?: { actor: string; at: number };
  editing: boolean;
  selected: boolean;
  onEdit: (text: string | null) => void;
}

function NoteEditor({ text, onEdit }: { text: string; onEdit: (text: string | null) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onEdit(value === null ? null : value.trim() === '' ? text : value);
  };
  const onBlur = useEditFocus(ref, finish);
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
      onBlur={onBlur}
    />
  );
}

export function NoteCard({ text, author, editing, selected, onEdit }: NoteCardProps) {
  const people = useContext(NoteAuthorsContext);
  const byline = noteByline(author, people);
  return (
    <div className={'free-note' + (selected ? ' free-note--selected' : '') + (editing ? ' free-note--editing' : '')} data-testid="free-note" role="note">
      <span className="free-note__pin" aria-hidden="true" />
      {editing ? <NoteEditor text={text} onEdit={onEdit} /> : <p className="free-note__text">{text || 'Note'}</p>}
      {byline !== null && <div className="free-note__by">{byline}</div>}
    </div>
  );
}
