import { useCallback, useEffect, useState } from 'react';
import { useReactFlow, useStore, type Viewport } from '@xyflow/react';

import { visibleRect, type Rect } from './stubs';

/** The visible canvas in flow space, updated when a pan or zoom ends (and on resize), never during the gesture. */
export function useSettledView(): { rect: Rect; zoom: number; settle: (vp: Viewport) => void } {
  const rf = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const [vp, setVp] = useState<Viewport>(() => rf.getViewport());
  const settle = useCallback((next: Viewport) => setVp((prev) => (prev.x === next.x && prev.y === next.y && prev.zoom === next.zoom ? prev : { x: next.x, y: next.y, zoom: next.zoom })), []);
  // The pane's first measure, and any resize: re-read the camera, which no move end announced.
  useEffect(() => settle(rf.getViewport()), [width, height, rf, settle]);
  return { rect: visibleRect(vp, { width, height }), zoom: vp.zoom, settle };
}
