import { useEffect, type RefObject } from 'react';
import { ViewportPortal, type Edge } from '@xyflow/react';

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

/** Every cable drawn once more above the devices. Pointed at or selected, a cable already ran over
 * every box between its ends (Key Maker's note on the cables card, 2026-10-27); now they all do, so a
 * patch lead never slips behind the switch it plugs into (Key Maker, 31 October, sign-off r67). The
 * pointed-at one comes last, on top of the rest. It takes no pointer events, so a press on a port
 * under a cable still starts a new cable, and hover and click reach what is underneath. */
export function CableTopLayer({ cableIds }: { cableIds: readonly string[] }) {
  const top = useLive((s) => s.hoveredCableId ?? s.litCableId);
  if (cableIds.length === 0 && top == null) return null;
  return (
    <ViewportPortal>
      <svg className="drawing-cable-top" width={1} height={1} aria-hidden="true" data-testid="cable-top">
        {cableIds.map((id) => (id === top ? null : <use key={id} href={`#${visualGroupId(id)}`} />))}
        {top != null && <use key={`top:${top}`} href={`#${visualGroupId(top)}`} data-testid="cable-top-lit" />}
      </svg>
    </ViewportPortal>
  );
}

/** While a cable is pointed at or selected, the drawing says so (`data-cable-focus`) and every
 * piece of equipment not on that cable's path dims (`drawing.css`). Set straight on the element,
 * so a hover re-renders nothing but this. */
export function CableFocus({ container }: { container: RefObject<HTMLDivElement | null> }) {
  const focused = useLive((s) => s.litCableId != null);
  useEffect(() => {
    const el = container.current;
    if (el == null) return;
    if (focused) el.dataset.cableFocus = '';
    else delete el.dataset.cableFocus;
  }, [container, focused]);
  return null;
}

/** Marks a node that holds a cable on the lit path, so it stays bright while the rest dims. */
export function LitPathMark({ cableIds }: { cableIds: ReadonlySet<string> }) {
  const on = useLive((s) => {
    if (s.litCableIdSet.size === 0) return false;
    for (const id of cableIds) if (s.litCableIdSet.has(id)) return true;
    return false;
  });
  return on ? <span className="drawing-lit-mark" data-lit-path="" hidden /> : null;
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
