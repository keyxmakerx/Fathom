import { useEffect, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import type { MenuItem } from './contextMenuItems';

export interface ContextMenuProps {
  /** Where the right-click landed, in the drawing's own pixels. */
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/**
 * The right-click menu (ADR-0060 decision 4): a flat hairline box at the
 * pointer, kept inside the drawing. A choice, Escape or a press anywhere else
 * closes it; the arrow keys move between its items.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Placed here rather than through `style`, so a re-render never undoes the
  // nudge that keeps a menu opened near an edge inside the drawing.
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.offsetParent;
    if (!el || !(parent instanceof HTMLElement)) return;
    el.style.left = `${Math.max(0, Math.min(x, parent.clientWidth - el.offsetWidth))}px`;
    el.style.top = `${Math.max(0, Math.min(y, parent.clientHeight - el.offsetHeight))}px`;
  });

  useEffect(() => {
    ref.current?.querySelector('button')?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [onClose]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(ref.current?.querySelectorAll('button') ?? []);
    const at = buttons.findIndex((b) => b === document.activeElement);
    const next =
      event.key === 'ArrowDown'
        ? (at + 1) % buttons.length
        : event.key === 'ArrowUp'
          ? (at - 1 + buttons.length) % buttons.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    buttons[next]?.focus();
  }

  return (
    <div
      ref={ref}
      className="drawing-context-menu"
      role="menu"
      onKeyDown={handleKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={item.danger ? 'drawing-context-menu__item drawing-context-menu__item--danger' : 'drawing-context-menu__item'}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
