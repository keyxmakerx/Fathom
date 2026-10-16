// The Back button over the canvas: "← BACK TO R1" says where Back goes, and a small ▾ beside it unfolds a
// tree of where you are inside the design (design, rack, device, port...). It stays out of the way: nothing
// shows until there is somewhere to go back to or something to show in the tree. There is no Forward
// button; Alt+Right and the mouse's forward button still go forward (`useJumpBack.ts`).

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';

import '../../styles/canvas-aids.css';

import { shortcutText } from '../shell/shortcuts';
import { canGoBack, type Trail } from './jumpBack';
import { KEEP_TOP, foldTrail, kindWord, nextFocus, type Level } from './jumpTree';

export interface JumpTrailProps {
  trail: Trail;
  backLabel: string | null;
  onBack: () => void;
  /** Where you are inside the design, outermost first; the last is "you are here". */
  levels: readonly Level[];
  /** A line of the tree was chosen. */
  onGo: (level: Level) => void;
  /** Starts unfolded (for tests and pictures). */
  defaultOpen?: boolean;
}

export function JumpTrail({ trail, backLabel, onBack, levels, onGo, defaultOpen = false }: JumpTrailProps) {
  const canBack = canGoBack(trail) && backLabel != null;
  const hasTree = levels.length > 1;
  const [open, setOpen] = useState(defaultOpen);
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const listId = useId();
  const shown = open && hasTree;

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setExpanded(false);
    if (refocus) toggleRef.current?.focus();
  }, []);

  // Esc and a click anywhere outside fold it.
  useEffect(() => {
    if (!shown) return undefined;
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return;
      close(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      close(true);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [shown, close]);

  // Opening puts focus on the line you are at, so the arrow keys work straight away.
  useEffect(() => {
    if (!shown || defaultOpen) return;
    listRef.current?.querySelector<HTMLButtonElement>('[aria-current="location"]')?.focus();
  }, [shown, defaultOpen]);

  // Unfolding the middle keeps focus where the fold was.
  useEffect(() => {
    if (expanded) listRef.current?.querySelectorAll<HTMLButtonElement>('button')[KEEP_TOP]?.focus();
  }, [expanded]);

  if (!canBack && !hasTree) return null;

  const lines = foldTrail(levels, expanded);
  const onListKey = (e: KeyboardEvent<HTMLOListElement>) => {
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
    const to = nextFocus(items.length, items.indexOf(document.activeElement as HTMLButtonElement), e.key);
    if (to == null) return;
    e.preventDefault();
    items[to]?.focus();
  };

  return (
    <nav className="jump-trail" aria-label="Back and where you are" data-print-omit="" ref={rootRef}>
      <div className="jump-trail__bar">
        {canBack && (
          <button type="button" className="jump-trail__nav" onClick={onBack} title={`Go back (${shortcutText('go-back')})`} data-testid="jump-back">
            <span aria-hidden="true">←</span> Back to {backLabel}
          </button>
        )}
        {hasTree && (
          <button
            type="button"
            ref={toggleRef}
            className="jump-trail__nav jump-trail__nav--icon"
            aria-expanded={shown}
            aria-controls={shown ? listId : undefined}
            aria-label="Where you are in this design"
            title="Where you are in this design"
            onClick={() => (shown ? close(false) : setOpen(true))}
            data-testid="jump-tree-toggle"
          >
            <span aria-hidden="true">▾</span>
          </button>
        )}
      </div>
      {shown && (
        <ol className="jump-tree" id={listId} ref={listRef} aria-label="Where you are in this design" onKeyDown={onListKey} data-testid="jump-tree">
          {lines.map((line) => {
            if (line.type === 'fold') {
              return (
                <li key="fold" className="jump-tree__item" style={{ '--depth': 2 } as CSSProperties}>
                  <button type="button" className="jump-tree__line jump-tree__line--fold" aria-expanded={false} onClick={() => setExpanded(true)} data-testid="jump-tree-fold">
                    <span aria-hidden="true">⋯</span> {line.hidden.length} more
                  </button>
                </li>
              );
            }
            const here = line.index === levels.length - 1;
            const { level } = line;
            return (
              <li key={level.key} className="jump-tree__item" style={{ '--depth': line.index } as CSSProperties}>
                <button
                  type="button"
                  className="jump-tree__line"
                  aria-current={here ? 'location' : undefined}
                  disabled={level.target == null}
                  onClick={() => {
                    close(true);
                    if (!here) onGo(level);
                  }}
                  data-testid="jump-tree-line"
                >
                  <span className="jump-tree__name">{level.name}</span>
                  <span className="jump-tree__kind">{kindWord(level.kind)}</span>
                  {here && <span className="jump-tree__here">you are here</span>}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </nav>
  );
}
