// Double-click a device, box or rack NAME on the canvas to rename it in place. The rest of the node
// keeps its double-click (it opens the device); only the name text starts the edit.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import '../../styles/inline-name.css';

/** What is being renamed: a device or box (by its chassis) or a rack. */
export interface RenameTarget {
  kind: 'chassis' | 'rack';
  id: string;
}

export interface NameEditApi {
  /** Saves a new name (blank for none). The caller words any refusal. */
  rename: (target: RenameTarget, value: string) => void;
}

/** Provided by the drawing only to someone who may edit, so a reader's name never turns into a field. */
export const NameEditContext = createContext<NameEditApi | null>(null);

/** The palette's Rename asks the name on the canvas to open for editing. */
export const RENAME_EVENT = 'fathom:rename';

export function requestRename(target: RenameTarget): void {
  window.dispatchEvent(new CustomEvent<RenameTarget>(RENAME_EVENT, { detail: target }));
}

/** What a rename saves: the trimmed words, or nothing when they did not change. */
export function renamedValue(before: string, typed: string): string | null {
  const next = typed.trim();
  return next === before.trim() ? null : next;
}

export function EditableName({
  target,
  text,
  className,
  children,
}: {
  target: RenameTarget;
  /** The name as stored ('' when unset); what the field starts with. */
  text: string;
  className?: string;
  /** What shows when not editing. */
  children: ReactNode;
}) {
  const api = useContext(NameEditContext);
  const [editing, setEditing] = useState(false);
  const doneRef = useRef(false);
  const start = useCallback(() => {
    doneRef.current = false;
    setEditing(true);
  }, []);

  useEffect(() => {
    if (api === null) return undefined;
    function onRequest(event: Event) {
      const want = (event as CustomEvent<RenameTarget>).detail;
      if (want.kind === target.kind && want.id === target.id) start();
    }
    window.addEventListener(RENAME_EVENT, onRequest);
    return () => window.removeEventListener(RENAME_EVENT, onRequest);
  }, [api, target.kind, target.id, start]);

  if (editing && api !== null) {
    const finish = (typed: string, save: boolean) => {
      if (doneRef.current) return;
      doneRef.current = true;
      setEditing(false);
      const value = save ? renamedValue(text, typed) : null;
      if (value !== null) api.rename(target, value);
    };
    return (
      <input
        className="inline-name nodrag nopan nowheel"
        aria-label="Name"
        defaultValue={text}
        autoFocus
        spellCheck={false}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            event.preventDefault();
            finish(event.currentTarget.value, true);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            finish(event.currentTarget.value, false);
          }
        }}
        onBlur={(event) => finish(event.currentTarget.value, true)}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      />
    );
  }

  return (
    <span
      className={className}
      title={api !== null ? 'Double-click to rename' : undefined}
      onDoubleClick={
        api === null
          ? undefined
          : (event) => {
              // The name only: the rest of the node still opens the device.
              event.stopPropagation();
              event.preventDefault();
              start();
            }
      }
    >
      {children}
    </span>
  );
}
