import { useEffect } from 'react';
import type { Edge } from '@xyflow/react';

import { cycle } from './cableHover';
import { visualGroupId } from './CableEdge';
import { useLive, useLiveStore } from './liveStore';

export type CableOverlayEdgeType = Edge<Record<string, never>, 'cableOverlay'>;

/** The id and type of the one top-layer edge `Drawing.tsx` adds. */
export const CABLE_OVERLAY_EDGE_ID = '__cable-overlay__';

/**
 * The top cable layer (round 15): the cable being pointed at, or else the selected one, drawn
 * again above every other cable so a crossing never hides it. It repeats that cable's own drawing
 * (`<use>`) and takes no pointer events, so the hover and click stay on the cable underneath.
 * It sits above the cables and below the devices, so ports stay on top as before.
 */
export function CableOverlayEdge() {
  const top = useLive((s) => s.hoveredCableId ?? s.litCableId);
  if (top == null) return null;
  return <use href={`#${visualGroupId(top)}`} pointerEvents="none" className="drawing-cable-overlay" data-testid="cable-overlay" />;
}

/** Tab while the pointer rests where cables cross moves to the next one under it; Shift+Tab goes
 * back. Only then: elsewhere Tab moves focus as usual. */
export function CableCrossingKeys() {
  const store = useLiveStore();
  const stack = useLive((s) => s.hoverStack);
  const current = useLive((s) => s.hoveredCableId);
  useEffect(() => {
    if (stack.length < 2) return undefined;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
      const s = store.getState();
      event.preventDefault();
      store.setState({ hoveredCableId: cycle(s.hoverStack, s.hoveredCableId, event.shiftKey) });
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [store, stack]);
  if (stack.length < 2) return null;
  const at = current == null ? 0 : stack.indexOf(current) + 1;
  return (
    <div className="drawing-cable-crossing" role="status" data-testid="cable-crossing">
      {stack.length} cables here · {at} of {stack.length} · Tab for the next
    </div>
  );
}
