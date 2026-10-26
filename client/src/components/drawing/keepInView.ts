// How far to pan so a box the camera just opened is not left under a side panel. The panel slides
// open as the camera glides, so the pane the glide centred in is wider than the one it lands in.

export interface ScreenRect {
  left: number;
  right: number;
}

/** Screen pixels to add to the viewport's x so `box` sits inside `pane` with `margin` to spare.
 * Positive moves the drawing right. When the box is wider than the pane, its left edge wins:
 * that is where a box's name and first ports are. */
export function panToShow(pane: ScreenRect, box: ScreenRect, margin: number): number {
  const minLeft = pane.left + margin;
  const maxRight = pane.right - margin;
  if (box.right - box.left > maxRight - minLeft) return minLeft - box.left;
  if (box.right > maxRight) return maxRight - box.right;
  if (box.left < minLeft) return minLeft - box.left;
  return 0;
}
