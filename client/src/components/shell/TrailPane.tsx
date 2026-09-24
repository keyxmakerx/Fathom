import type { ReactNode } from 'react';

export interface TrailPaneProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/** The trail, folded to a strip on the right edge (the owner's option B).
 * The whole strip is the button; open, the trail sits beside it. */
export function TrailPane({ open, onOpenChange, children }: TrailPaneProps) {
  return (
    <div className="shell-trail-wrap">
      {open && (
        <aside className="shell-trail" aria-label="Trail">
          {children}
        </aside>
      )}
      <button
        type="button"
        className="shell-strip shell-strip--trail"
        aria-label={open ? 'Close the trail' : 'Open the trail'}
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <span className="shell-strip__handle" aria-hidden="true">
          {open ? '›' : '‹'}
        </span>
        <span className="shell-strip__word" aria-hidden="true">
          Trail
        </span>
      </button>
    </div>
  );
}
