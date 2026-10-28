// An AI idea's proposed change on the canvas (owner, 2026-10-27): drawn as an open plan is, in the plan colour, with
// what it removes greyed and the rest faded, until the person accepts or dismisses it. The ideas panel writes the
// preview; this only reads it.
import { useEffect, useMemo, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';

import { useAiPreview } from '../ai/aiPreview';
import type { Canon } from '../checks/checksModel';
import { useChecksApi, useChecksShow } from '../checks/checksStore';
import { applyPlans, focusMatch, type ResolvePort } from './plansMarks';

const IDENTITY: Canon = (id) => id;

/** The same arrays, untouched, unless an idea is being shown. A Checks Show wins the fade. */
export function useAiPreviewMarks(nodes: Node[], edges: Edge[], resolvePort?: ResolvePort): { nodes: Node[]; edges: Edge[] } {
  const preview = useAiPreview();
  const api = useChecksApi();
  const checksShowing = useChecksShow() != null;
  const resolveRef = useRef(resolvePort);
  resolveRef.current = resolvePort;
  return useMemo(
    () =>
      preview.ideaId == null
        ? { nodes, edges }
        : applyPlans({
            nodes,
            edges,
            plans: { stage: 'planned', marks: preview.marks, focus: preview.focus },
            canon: preview.canon ?? api?.store.get().canon ?? IDENTITY,
            resolvePort: (id) => resolveRef.current?.(id) ?? null,
            checksShowing,
          }),
    [preview, api, checksShowing, nodes, edges],
  );
}

/** Inside the drawing's React Flow provider: fits the view to what the idea touches when one is shown, and again
 * once what it adds is drawn. */
export function AiPreviewCanvasBridge() {
  const { ideaId, focus, doc, canon } = useAiPreview();
  const drawn = doc != null;
  const api = useChecksApi();
  const rf = useReactFlow();

  useEffect(() => {
    if (ideaId == null || focus == null) return;
    // The drawn copy reaches React Flow a frame after the store changes.
    const frame = requestAnimationFrame(() => {
      const { nodeIds } = focusMatch(rf.getNodes(), rf.getEdges(), focus, canon ?? api?.store.get().canon ?? IDENTITY);
      if (nodeIds.size > 0) void rf.fitView({ nodes: [...nodeIds].map((id) => ({ id })), padding: 0.5, maxZoom: 1.25, duration: 400 });
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one move per idea shown, and one once it is drawn
  }, [ideaId, drawn]);

  return null;
}
