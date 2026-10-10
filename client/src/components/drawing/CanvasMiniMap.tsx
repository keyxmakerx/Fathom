// The mini-map: the whole drawing in a corner, with a box for what the window shows. Drag the box to
// move, scroll over it to zoom. It appears only on big drawings (`minimap.ts`) and when the Show menu
// has it ticked. Drawn inside React Flow, so it reads the same camera and boxes as the canvas.

import { useEffect, useState } from 'react';
import { MiniMap, getNodesBounds, useReactFlow, useStore } from '@xyflow/react';
import '../../styles/canvas-aids.css';

import { isBigDrawing, type Size } from './minimap';

const WIDTH = 176;
const HEIGHT = 120;
/** Boxes get their measured size a moment after they are added; measure again once they have. */
const REMEASURE_MS = 500;

export function CanvasMiniMap({ enabled }: { enabled: boolean }) {
  const rf = useReactFlow();
  const nodeCount = useStore((s) => s.nodeLookup.size);
  const paneWidth = useStore((s) => s.width);
  const paneHeight = useStore((s) => s.height);
  const [content, setContent] = useState<Size | null>(null);

  // The size of everything drawn, in drawing units (zoom 1). Re-measured when boxes come or go,
  // not on every pan, so a drag across a thousand boxes costs nothing here.
  useEffect(() => {
    if (!enabled) return undefined;
    const measure = () => {
      const nodes = rf.getNodes();
      if (nodes.length === 0) return setContent(null);
      const b = getNodesBounds(nodes);
      setContent((prev) => (prev != null && Math.round(prev.width) === Math.round(b.width) && Math.round(prev.height) === Math.round(b.height) ? prev : { width: b.width, height: b.height }));
    };
    measure();
    const t = setTimeout(measure, REMEASURE_MS);
    return () => clearTimeout(t);
  }, [enabled, rf, nodeCount]);

  if (!enabled || !isBigDrawing({ nodeCount, content, pane: { width: paneWidth, height: paneHeight } })) return null;
  return (
    <MiniMap
      className="canvas-minimap"
      position="bottom-right"
      style={{ width: WIDTH, height: HEIGHT }}
      pannable
      zoomable
      nodeBorderRadius={0}
      nodeStrokeWidth={0}
      ariaLabel="Mini-map of the whole drawing. Drag the box to move the view."
      data-print-omit=""
    />
  );
}
