import { useEffect, useRef, useState } from 'react';

import type { CableKind, Sheath } from './contract';
import { SHEATH_VAR, sheathsFor } from './sheath';

export interface ColourPickerProps {
  kind: CableKind;
  /** The colour used last for this kind, this session — preselected, per
   * UI-SPEC "Drag-to-connect". */
  initial: Sheath;
  /** Screen pixels, not flow space — the picker is a fixed-size overlay,
   * not something that grows or shrinks with the canvas zoom (`Drawing.tsx`
   * converts the drop point with `flowToScreenPosition` before rendering
   * this). */
  screenX: number;
  screenY: number;
  onConfirm: (sheath: Sheath) => void;
  onCancel: () => void;
}

/**
 * The colour picker — UI-SPEC "Drag-to-connect": "drop on a live port opens
 * the colour picker as the one popover kind, listing the sheaths for that
 * cable kind... with the last-used one for that kind preselected and Enter
 * accepting it." `components/shell/Popover.tsx` is that one popover kind's
 * component, but its API is a persistent click-to-open trigger (the bar's
 * own menus) — this picker instead appears already open, anchored to
 * wherever a drop just happened, and closes on its own action rather than
 * a caller toggling it. It borrows that component's *language* instead
 * (hairline border, `--surface-2`, zero radius, closed by Escape or a
 * click away, never a second level) via `drawing.css`'s `.drawing-picker*`
 * rules, kept deliberately parallel to `shell.css`'s `.shell-popover*`.
 */
export function ColourPicker({ kind, initial, screenX, screenY, onConfirm, onCancel }: ColourPickerProps) {
  const [selected, setSelected] = useState<Sheath>(initial);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
      } else if (event.key === 'Enter') {
        event.stopPropagation();
        onConfirm(selectedRef.current);
      }
    }
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      onCancel();
    }
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [onCancel, onConfirm]);

  const sheaths = sheathsFor(kind);

  return (
    <div
      ref={rootRef}
      className="drawing-picker"
      role="menu"
      style={{ position: 'fixed', left: screenX, top: screenY }}
    >
      <div className="drawing-picker__title">Sheath &mdash; the lead you actually used</div>
      <div className="drawing-picker__swatches">
        {sheaths.map((sheath) => (
          <button
            key={sheath}
            type="button"
            role="menuitemradio"
            aria-checked={sheath === selected}
            aria-label={sheath}
            className={
              sheath === selected ? 'drawing-picker__swatch drawing-picker__swatch--selected' : 'drawing-picker__swatch'
            }
            style={{ background: SHEATH_VAR[sheath] }}
            onClick={() => {
              setSelected(sheath);
              onConfirm(sheath);
            }}
          />
        ))}
      </div>
      <div className="drawing-picker__name">{selected}</div>
      <div className="drawing-picker__hint">Enter to accept &middot; Esc to cancel</div>
    </div>
  );
}
