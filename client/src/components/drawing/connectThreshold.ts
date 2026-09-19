/**
 * UI-SPEC "Cables"/this session's brief item 2 — "Keep drag-to-connect
 * working: a click without movement selects, a drag connects." React Flow's
 * own `<ReactFlow connectionDragThreshold>` (`@xyflow/react`, default 1px)
 * is what makes this true: `onConnectStart` never fires — a plain click
 * never enters "connecting" at all, so `Drawing.tsx`'s port glyph's own
 * `onClick` is the only thing that runs — until the pointer has moved past
 * the threshold (`@xyflow/system`'s own `onPointerDown`: `dx*dx + dy*dy >
 * dragThreshold*dragThreshold`). This file never reimplements that check —
 * only names the number `Drawing.tsx` hands the library, and mirrors the
 * library's own formula, pure, so the rule the chosen number enforces can be
 * asserted without a DOM or a real pointer.
 */

/** The default (1px) is tight enough that an imprecise trackpad click can
 * cross it by accident and start a spurious connection; "a few pixels" (the
 * brief's own words) is more forgiving of a real click without reading as a
 * drag to someone who actually meant to connect. */
export const PORT_CLICK_DRAG_THRESHOLD_PX = 4;

/** The exact rule `@xyflow/system`'s own `onPointerDown` applies: a pointer
 * that has moved `(dx, dy)` from where it went down counts as a drag once
 * that distance exceeds `thresholdPx`, never at or under it (a click held
 * exactly on the threshold is still a click, the same "closed" reading
 * `filterCablesByVisibility`'s own `'all'`/`'none'` boundary needs no test
 * for since there is nothing between them — here there is, so it is
 * asserted directly below). */
export function isDragMovement(dx: number, dy: number, thresholdPx: number = PORT_CLICK_DRAG_THRESHOLD_PX): boolean {
  return dx * dx + dy * dy > thresholdPx * thresholdPx;
}
