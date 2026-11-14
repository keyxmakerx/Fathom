// r116: one head for every right-hand panel: its name, a ⋯ where the thing has a menu, and one fold arrow.

import { createContext, useContext, type HTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Popover, PopoverRow } from './Popover';

/** The head's slot for a panel's own ⋯ menu (the device's), so a panel can draw it in the head, not in its body. */
export const HeadMenuHost = createContext<HTMLElement | null>(null);

/** Draws its children in the head's ⋯ slot; with no head around it (tests, other places) they draw where they are. */
export function InHeadMenu({ children }: { children: ReactNode }) {
  const host = useContext(HeadMenuHost);
  return host != null ? createPortal(children, host) : <>{children}</>;
}

export interface PanelHeadRow {
  label: string;
  onSelect: () => void;
  testId?: string;
}

export interface PanelHeadProps {
  name: string;
  /** The one fold arrow. */
  onFold: () => void;
  /** A ⋯ with these rows. */
  rows?: readonly PanelHeadRow[];
  /** Or a ⋯ the caller draws itself. */
  menu?: ReactNode;
  /** Where `InHeadMenu` content lands. */
  hostRef?: (el: HTMLElement | null) => void;
  testId?: string;
  /** Pointer handlers, for a panel that is dragged about by its head when it is not docked. */
  dragProps?: HTMLAttributes<HTMLElement>;
}

export function PanelHead({ name, onFold, rows, menu, hostRef, testId, dragProps }: PanelHeadProps) {
  return (
    <header className="panel-head" data-testid={testId ?? 'panel-head'} data-drag={dragProps != null && Object.keys(dragProps).length > 0 ? '' : undefined} {...dragProps}>
      <h2 className="panel-head__name">{name}</h2>
      <span className="panel-head__tools">
        {rows != null && rows.length > 0 && (
          <Popover
            align="right"
            renderTrigger={({ triggerProps, triggerRef }) => (
              <button
                type="button"
                className="panel-head__dots"
                aria-label={`More for ${name}`}
                title={`More for ${name}`}
                data-testid="panel-head-dots"
                ref={(el) => {
                  triggerRef.current = el;
                }}
                {...triggerProps}
              >
                ⋯
              </button>
            )}
          >
            {rows.map((row) => (
              <PopoverRow key={row.label} onSelect={row.onSelect} testId={row.testId}>
                {row.label}
              </PopoverRow>
            ))}
          </Popover>
        )}
        {menu}
        <span className="panel-head__menu" ref={hostRef} />
        <button type="button" className="panel-head__fold" aria-label={`Fold ${name}`} title={`Fold ${name} (Esc)`} data-testid="panel-fold" onClick={onFold}>
          <span aria-hidden="true">›</span>
        </button>
      </span>
    </header>
  );
}
