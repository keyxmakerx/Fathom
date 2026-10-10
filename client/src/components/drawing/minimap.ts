// When the mini-map is worth showing. Pure; the component is `CanvasMiniMap.tsx`.

/** More than this many boxes on the canvas is a big drawing. */
export const BIG_NODE_COUNT = 40;
/** Content more than this many times the window, in either direction, is a big drawing. */
export const BIG_VIEW_RATIO = 2;

export interface Size {
  width: number;
  height: number;
}

/** A drawing is big when it holds more than 40 boxes, or when its content (measured at 100% zoom) is
 * more than twice as wide or as tall as the window it is shown in. */
export function isBigDrawing(input: { nodeCount: number; content: Size | null; pane: Size | null }): boolean {
  if (input.nodeCount > BIG_NODE_COUNT) return true;
  const { content, pane } = input;
  if (content == null || pane == null || pane.width <= 0 || pane.height <= 0) return false;
  return content.width > BIG_VIEW_RATIO * pane.width || content.height > BIG_VIEW_RATIO * pane.height;
}
