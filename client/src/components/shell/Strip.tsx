import { useState } from 'react';

/**
 * The rail folded to a 28px strip — BRIEF.md "Under the bar": "a small ›
 * handle (the rail opens on click) and three 16×16 marks stacked with 12px
 * gaps — a rack outline, a plug outline, a building outline — each just a
 * 1px ink line drawing. A hover label would name them; draw none."
 *
 * The marks themselves carry no click behaviour in this build — nothing in
 * `ShellProps` supplies what they would open, so they are drawn and nothing
 * else (they are `aria-hidden`, matching "draw no hover labels"). The
 * handle does act: it opens the rail. This build has no content to put in
 * that rail yet (no prop supplies it), so opening it shows the honest empty
 * state rather than inventing rack names.
 */
export function Strip() {
  const [open, setOpen] = useState(false);

  return (
    <div className="shell-strip-wrap">
      <div className="shell-strip">
        <button
          type="button"
          className="shell-strip__handle"
          aria-label={open ? 'Close the rail' : 'Open the rail'}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden="true">&rsaquo;</span>
        </button>

        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          aria-hidden="true"
          className="shell-strip__mark"
        >
          <rect x="2.5" y="1.5" width="11" height="13"></rect>
          <path d="M4.5 1.5 V14.5 M11.5 1.5 V14.5 M4.5 5.5 H11.5 M4.5 8.5 H11.5 M4.5 11.5 H11.5"></path>
        </svg>
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          aria-hidden="true"
          className="shell-strip__mark"
        >
          <rect x="3.5" y="5.5" width="9" height="9"></rect>
          <path d="M6.5 5.5 V2.5 H9.5 V5.5 M5.5 14.5 V11.5 M8 14.5 V11.5 M10.5 14.5 V11.5"></path>
        </svg>
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          aria-hidden="true"
          className="shell-strip__mark"
        >
          <rect x="3.5" y="2.5" width="9" height="12"></rect>
          <path d="M5.5 5 H7.5 M8.5 5 H10.5 M5.5 8 H7.5 M8.5 8 H10.5 M7 14.5 V11.5 H9 V14.5"></path>
        </svg>
      </div>

      {open && (
        <nav className="shell-rail" aria-label="Racks and equipment">
          <p className="shell-rail__empty">Nothing to show yet.</p>
        </nav>
      )}
    </div>
  );
}
