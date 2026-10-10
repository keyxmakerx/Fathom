import type { ReactNode } from 'react';

import { DockSlot } from './Dock';
import type { PanelId } from './panelSizing';
import { EmptyState } from '../ui/EmptyState';

export interface StripProps {
  /** The open rail's content, e.g. the Canvas place's equipment list. `null` or
   * omitted shows the honest empty state below rather than inventing rail
   * content. */
  rail?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The width to draw, already held to the canvas minimum, and the most it can be dragged to. */
  width: number;
  max: number;
  onResize: (panel: PanelId, width: number, commit: boolean) => void;
  onReset: (panel: PanelId) => void;
  onDragging: (dragging: boolean) => void;
}

/**
 * The equipment list, folded to a 28px strip on the left. The whole strip is
 * the button and reads "Equipment", like the trail's strip on the right
 * (ADR-0060 decision 4 retired the three unlabelled marks that did nothing).
 * Open, the list slides out beside it with a drag handle on its right edge.
 */
export function Strip({ rail, open, onOpenChange, width, max, onResize, onReset, onDragging }: StripProps) {
  const label = open ? 'Close the equipment list' : 'Open the equipment list';

  return (
    <div className="shell-strip-wrap">
      <button
        type="button"
        className="shell-strip shell-strip--rail"
        aria-label={label}
        title={label}
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <span className="shell-strip__handle" aria-hidden="true">
          {open ? '‹' : '›'}
        </span>
        <span className="shell-strip__word" aria-hidden="true">
          Equipment
        </span>
      </button>

      <DockSlot side="left" open={open} width={width} name="Equipment" panel="rail" max={max} onResize={onResize} onReset={onReset} onDragging={onDragging}>
        <nav className="shell-rail" aria-label="Equipment">
          {rail ?? (
            <EmptyState className="shell-rail__empty" title="Nothing to show yet." compact>
              Equipment you can add to the drawing is listed here.
            </EmptyState>
          )}
        </nav>
      </DockSlot>
    </div>
  );
}
