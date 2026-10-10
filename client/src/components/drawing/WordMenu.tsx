import { useState } from 'react';

import { ContextMenu } from './ContextMenu';
import type { AlignMode } from './freeLayout';

/** The flat word menu over a selection (ADR-0060 step 7): Align, Spread, Group, Label. */
export interface WordMenuProps {
  /** The selection's top-left and width in the drawing's own pixels; the menu sits above it. */
  x: number;
  y: number;
  count: number;
  onAlign: (mode: AlignMode) => void;
  onSpread: (axis: 'x' | 'y') => void;
  onGroup: () => void;
  onLabel: () => void;
  /** Pins a note beside the selection; absent leaves the word out. */
  onNote?: () => void;
}

const ALIGNS: readonly { mode: AlignMode; label: string }[] = [
  { mode: 'left', label: 'Left edges' },
  { mode: 'centre', label: 'Centres' },
  { mode: 'right', label: 'Right edges' },
  { mode: 'top', label: 'Top edges' },
  { mode: 'middle', label: 'Middles' },
  { mode: 'bottom', label: 'Bottom edges' },
];

export function WordMenu({ x, y, count, onAlign, onSpread, onGroup, onLabel, onNote }: WordMenuProps) {
  const [open, setOpen] = useState<{ which: 'align' | 'spread'; x: number; y: number } | null>(null);
  const parent = (e: { currentTarget: HTMLElement }) => {
    const at = e.currentTarget.getBoundingClientRect();
    const frame = (e.currentTarget.closest('.drawing') as HTMLElement).getBoundingClientRect();
    return { x: at.left - frame.left, y: at.bottom - frame.top };
  };
  return (
    <>
    <div className="free-wordmenu nodrag nopan" style={{ left: x, top: Math.max(4, y - 38), transform: 'translateX(-50%)' }} role="toolbar" aria-label="Arrange the selection">
      {count >= 2 && (
        <button type="button" className="free-wordmenu__item" onClick={(e) => setOpen({ which: 'align', ...parent(e) })}>
          Align
        </button>
      )}
      {count >= 3 && (
        <button type="button" className="free-wordmenu__item" onClick={(e) => setOpen({ which: 'spread', ...parent(e) })}>
          Spread
        </button>
      )}
      <button type="button" className="free-wordmenu__item" onClick={onGroup}>
        Group
      </button>
      <button type="button" className="free-wordmenu__item" onClick={onLabel}>
        Label
      </button>
      {onNote && (
        <button type="button" className="free-wordmenu__item" onClick={onNote}>
          Note
        </button>
      )}
    </div>
      {open?.which === 'align' && (
        <ContextMenu
          x={open.x}
          y={open.y}
          onClose={() => setOpen(null)}
          items={ALIGNS.map((a) => ({ label: a.label, onSelect: () => onAlign(a.mode) }))}
        />
      )}
      {open?.which === 'spread' && (
        <ContextMenu
          x={open.x}
          y={open.y}
          onClose={() => setOpen(null)}
          items={[
            { label: 'Across', onSelect: () => onSpread('x') },
            { label: 'Down', onSelect: () => onSpread('y') },
          ]}
        />
      )}
    </>
  );
}
