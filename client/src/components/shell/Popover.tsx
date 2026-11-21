import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react';

import { useGhostRef } from './ghost';
import { MENU_ROWS, rowAfter, usesArrows } from './menuKeys';

export interface PopoverTriggerArgs {
  open: boolean;
  /** Open/close the popover. Call this from whichever element the caller
   * renders as the trigger. */
  toggle: () => void;
  /** Assign this to the element that was actually clicked to open the
   * popover (normally via its `onClick`), so Escape can return focus there.
   * A plain mutable ref, not a React `ref` prop — set `.current` yourself. */
  triggerRef: RefObject<HTMLElement | null>;
  /** Spread onto the trigger element for the standard disclosure wiring. */
  triggerProps: {
    onClick: () => void;
    'aria-haspopup': 'menu';
    'aria-expanded': boolean;
    'aria-controls': string;
  };
}

export interface PopoverProps {
  renderTrigger: (args: PopoverTriggerArgs) => ReactNode;
  children: ReactNode;
  /** Which edge the popover box hangs from. Default left (under the path);
   * `right` for boxes anchored to the bar's right edge (the account menu). */
  align?: 'left' | 'right';
  className?: string;
}

/**
 * The one popover kind the shell uses everywhere it needs a small menu —
 * the shell brief "Under the bar": "Popovers are one kind... Opened by a click,
 * closed by clicking away or by Escape. Never more than one level." The
 * tree, the account menu, and everything later (ADR-0047 §3: the far-end
 * picker, the colour picker, the release picker, right-click menus) share
 * this component rather than reimplementing the behaviour.
 *
 * It traps nothing: Tab moves through the page as normal. Escape closes it
 * and returns focus to whichever element opened it. The arrow keys go
 * through its rows (`menuKeys.ts`).
 */
/** Lets a row close the pop-over it sits in once it has acted. */
const CloseContext = createContext<() => void>(() => {});

/** The same close a `PopoverRow` calls before `onSelect`, for a row that
 * renders something else and must decide for itself whether a press
 * closes the popover. */
export function usePopoverClose(): () => void {
  return useContext(CloseContext);
}

export function Popover({ renderTrigger, children, align = 'left', className }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Closed, the box leaves a still copy that fades out (`ghost.ts`).
  const boxRef = useGhostRef(popoverRef);
  const id = useId();

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (popoverRef.current?.contains(target)) {
        return;
      }
      if (triggerRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    }

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);

  function toggle() {
    setOpen((value) => !value);
  }

  // The arrow keys go through the rows of an open menu, as Tab does. Pressed on the button that opened it, Down
  // goes in at the top and Up at the bottom. A key a row used itself, or a field types with, is left alone.
  function onKeys(event: ReactKeyboardEvent<HTMLDivElement>) {
    const box = popoverRef.current;
    const on = document.activeElement;
    if (!open || box == null || !(on instanceof HTMLElement) || event.defaultPrevented) return;
    const onTrigger = on.closest('[aria-controls]')?.getAttribute('aria-controls') === id;
    if (!onTrigger && (!box.contains(on) || usesArrows(on))) return;
    const rows = Array.from(box.querySelectorAll<HTMLElement>(MENU_ROWS)).filter((row) => row.getClientRects().length > 0);
    const next = rowAfter(event, onTrigger ? -1 : rows.indexOf(on), rows.length);
    if (next == null) return;
    event.preventDefault();
    rows[next]?.focus();
  }

  const classes = ['shell-popover', align === 'right' ? 'shell-popover--right' : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className="shell-popover-host" onKeyDown={onKeys}>
      {renderTrigger({
        open,
        toggle,
        triggerRef,
        triggerProps: {
          onClick: toggle,
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          'aria-controls': id,
        },
      })}
      {open && (
        <div className={classes} role="menu" id={id} ref={boxRef}>
          <CloseContext.Provider value={() => setOpen(false)}>{children}</CloseContext.Provider>
        </div>
      )}
    </div>
  );
}

export interface PopoverRowProps {
  children: ReactNode;
  /** Drawn 700 — the shell brief "the current row 700". */
  current?: boolean;
  disabled?: boolean;
  muted?: boolean;
  onSelect?: () => void;
  /** `data-testid`, for the browser drives. */
  testId?: string;
}

/** One row inside a `Popover` — the shell brief "rows of 12px text with 5px 12px
 * padding, the current row 700". A real `<button>`, since every row acts. */
export function PopoverRow({ children, current = false, disabled = false, muted = false, onSelect, testId }: PopoverRowProps) {
  const close = useContext(CloseContext);
  const classes = [
    'shell-popover__row',
    current ? 'shell-popover__row--current' : '',
    muted ? 'shell-popover__row--muted' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      role="menuitem"
      className={classes}
      disabled={disabled}
      data-testid={testId}
      onClick={() => {
        // A row that acts closes its pop-over: the screen beneath may be a
        // new one, and a menu left open over it swallows the next click.
        if (!onSelect) return;
        close();
        onSelect();
      }}
    >
      {children}
    </button>
  );
}
