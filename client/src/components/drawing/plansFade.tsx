// An open plan on the canvas, the way Checks' Show is (ADR-0061 round 7): marks on what the plan touches, a
// dashed ghost for a cable it adds, and the fade to the phantom 28% around a focus. The camera follows the
// panel's token. The plan store is read only; the plan panel writes it.
import { useEffect, useMemo, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';

import type { Canon } from '../checks/checksModel';
import { useChecksApi, useChecksShow } from '../checks/checksStore';
import { usePlansState } from '../plans/plansStore';
import { applyPlans, focusMatch, type ResolvePort } from './plansMarks';

const IDENTITY: Canon = (id) => id;

/** The same arrays, untouched, unless a plan is open with something to draw. A Checks Show wins the fade. */
export function usePlansFade(nodes: Node[], edges: Edge[], resolvePort?: ResolvePort): { nodes: Node[]; edges: Edge[] } {
  const plans = usePlansState();
  const api = useChecksApi();
  const checksShowing = useChecksShow() != null;
  // The drawing makes a new resolver each render; only the nodes and edges say when positions moved.
  const resolveRef = useRef(resolvePort);
  resolveRef.current = resolvePort;
  return useMemo(
    () =>
      applyPlans({
        nodes,
        edges,
        plans,
        canon: api?.store.get().canon ?? IDENTITY,
        resolvePort: (id) => resolveRef.current?.(id) ?? null,
        checksShowing,
      }),
    [plans, api, checksShowing, nodes, edges],
  );
}

/** Inside the drawing's React Flow provider: fits the view to the focus when the panel bumps the token. */
export function PlansCanvasBridge() {
  const { focus, token } = usePlansState();
  const api = useChecksApi();
  const rf = useReactFlow();

  useEffect(() => {
    if (focus == null || token === 0) return;
    const { nodeIds } = focusMatch(rf.getNodes(), rf.getEdges(), focus, api?.store.get().canon ?? IDENTITY);
    if (nodeIds.size > 0) void rf.fitView({ nodes: [...nodeIds].map((id) => ({ id })), padding: 0.5, maxZoom: 1.25, duration: 400 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one move per token
  }, [token]);

  return null;
}
