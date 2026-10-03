// One pointer drag for every small square handle (edge squares, area and shelf grips): the
// deltas arrive in flow units, Esc cancels, and a press that never moved reports as a click.

import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from '@xyflow/react';

/** A press that moves less than this many screen pixels is a click, not a drag. */
export const GRIP_CLICK_PX = 4;

export interface GripDrag {
  /** Pointer travel since the press, in flow units. */
  dx: number;
  dy: number;
  /** True once the pointer has moved past `GRIP_CLICK_PX`. */
  moved: boolean;
  event: PointerEvent;
}

export interface GripHandlers {
  onMove?(drag: GripDrag): void;
  /** `cancelled` is true for Esc; a click is `drag.moved === false`. */
  onEnd(drag: GripDrag, cancelled: boolean): void;
}

export function useGripDrag(handlers: GripHandlers): (event: ReactPointerEvent) => void {
  const zoom = useStore((s) => s.transform[2]);
  const latest = useRef(handlers);
  latest.current = handlers;
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  return useCallback(
    (down: ReactPointerEvent) => {
      if (down.button !== 0) return;
      down.stopPropagation();
      down.preventDefault();
      const startX = down.clientX;
      const startY = down.clientY;
      let moved = false;
      const drag = (event: PointerEvent): GripDrag => {
        const px = event.clientX - startX;
        const py = event.clientY - startY;
        if (!moved && Math.hypot(px, py) >= GRIP_CLICK_PX) moved = true;
        return { dx: px / zoom, dy: py / zoom, moved, event };
      };
      const stop = (): void => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('keydown', onKey, true);
        cleanup.current = null;
      };
      const onMove = (event: PointerEvent): void => {
        const d = drag(event);
        if (d.moved) latest.current.onMove?.(d);
      };
      const onUp = (event: PointerEvent): void => {
        stop();
        latest.current.onEnd(drag(event), false);
      };
      const onKey = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        stop();
        latest.current.onEnd({ dx: 0, dy: 0, moved: false, event: new PointerEvent('pointercancel') }, true);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('keydown', onKey, true);
      cleanup.current = stop;
    },
    [zoom],
  );
}
