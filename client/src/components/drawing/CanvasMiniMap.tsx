// The mini-map: the whole drawing in a corner, with a box for what the window shows. Drag the box to
// move, scroll over it to zoom. It shows whenever the Show menu has it ticked and there is anything drawn.
// Drawn inside React Flow, so it reads the same camera and boxes as the canvas.

import { MiniMap, useStore } from '@xyflow/react';
import '../../styles/canvas-aids.css';

const WIDTH = 176;
const HEIGHT = 120;

export function CanvasMiniMap({ enabled }: { enabled: boolean }) {
  const nodeCount = useStore((s) => s.nodeLookup.size);
  if (!enabled || nodeCount === 0) return null;
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
