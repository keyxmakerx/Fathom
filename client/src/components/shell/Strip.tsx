import type { ReactNode } from 'react';
import { useState } from 'react';

export interface StripProps {
  /** The open rail's content, e.g. the Canvas place's equipment list. `null` or
   * omitted shows the honest empty state below rather than inventing rail
   * content. */
  rail?: ReactNode;
}

/**
 * The equipment list, folded to a 28px strip on the left. The whole strip is
 * the button and reads "Equipment", like the trail's strip on the right
 * (ADR-0060 decision 4 retired the three unlabelled marks that did nothing).
 */
export function Strip({ rail }: StripProps) {
  const [open, setOpen] = useState(false);
  const label = open ? 'Close the equipment list' : 'Open the equipment list';

  return (
    <div className="shell-strip-wrap">
      <button
        type="button"
        className="shell-strip shell-strip--rail"
        aria-label={label}
        title={label}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="shell-strip__handle" aria-hidden="true">
          {open ? '\u2039' : '\u203a'}
        </span>
        <span className="shell-strip__word" aria-hidden="true">
          Equipment
        </span>
      </button>

      {open && (
        <nav className="shell-rail" aria-label="Equipment">
          {rail ?? <p className="shell-rail__empty">Nothing to show yet.</p>}
        </nav>
      )}
    </div>
  );
}
