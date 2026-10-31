import { Fragment, useEffect, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import type { MenuItem } from './contextMenuItems';

export interface ContextMenuProps {
  /** Where the right-click landed, in the drawing's own pixels. */
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  /** An uppercase spaced heading above the items, such as the NEW box menu's. */
  title?: string;
}

/**
 * The right-click menu (ADR-0060 decision 4): a flat hairline box at the
 * pointer, kept inside the drawing. A choice, Escape or a press anywhere else
 * closes it; the arrow keys move between its items.
 */
export function ContextMenu({ x, y, items, onClose, title }: ContextMenuProps) {
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
    // Sign-off r60: Escape closes only the top thing. The menu is on top, so it takes the key before the
    // canvas underneath can read it as "clear the selection" too.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
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
      {title ? <div className="drawing-context-menu__title">{title}</div> : null}
      <MenuItems items={items} onPicked={onClose} />
    </div>
  );
}

/**
 * A menu's items, drawn the same wherever a device's actions are listed (sign-off r58): right-click,
 * the panel's ⋯ menu and Inventory's row menu. A heading each time the group changes; an item that
 * cannot be used yet stays, greyed, with why under it; its key on the right; removal apart, after a rule.
 */
export function MenuItems({ items, onPicked }: { items: readonly MenuItem[]; onPicked?: () => void }) {
  return (
    <>
      {items.map((item, i) => {
        const before = items[i - 1];
        const heading = item.group != null && item.group !== before?.group ? item.group : null;
        const why = item.disabled != null ? `menu-why-${i}-${item.label.replace(/\W+/g, '-')}` : undefined;
        const cls = ['drawing-context-menu__item'];
        if (item.danger) cls.push('drawing-context-menu__item--danger');
        if (item.disabled != null) cls.push('drawing-context-menu__item--off');
        return (
          <Fragment key={item.label}>
            {heading != null ? (
              <div className="drawing-context-menu__group" role="presentation">
                {heading}
              </div>
            ) : null}
            <button
              type="button"
              role="menuitem"
              className={cls.join(' ')}
              aria-label={item.label}
              aria-disabled={item.disabled != null ? true : undefined}
              aria-describedby={why}
              aria-keyshortcuts={item.keys?.replace('Ctrl', 'Control').replace('Cmd', 'Meta')}
              onClick={() => {
                // A greyed item stays reachable by the arrow keys, so its reason is read out; it does nothing.
                if (item.disabled != null) return;
                onPicked?.();
                item.onSelect();
              }}
            >
              <span className="drawing-context-menu__label">{item.label}</span>
              {item.keys != null ? <kbd aria-hidden="true">{item.keys}</kbd> : null}
              {item.disabled != null ? (
                <span id={why} className="drawing-context-menu__why">
                  {item.disabled}
                </span>
              ) : null}
            </button>
          </Fragment>
        );
      })}
    </>
  );
}
