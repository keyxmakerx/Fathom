// A running "It's down" session on the canvas (ADR-0061 troubleshooting): the chain lit, the rest faded, in ink.
// The store is read only; the panel writes it. The camera follows the panel's token.
import { useEffect, useMemo } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';

import type { Canon } from '../checks/checksModel';
import { useChecksApi, useChecksShow } from '../checks/checksStore';
import { useTroubleState } from '../troubleshoot/troubleStore';
import { matchShown } from '../checks/checksModel';
import { applyTrouble } from './troubleMarks';

const IDENTITY: Canon = (id) => id;

/** The same arrays, untouched, unless a session runs. A Checks Show wins the fade. */
export function useTroubleFade(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } {
  const trouble = useTroubleState();
  const api = useChecksApi();
  const checksShowing = useChecksShow() != null;
  return useMemo(
    () => applyTrouble({ nodes, edges, trouble, canon: api?.store.get().canon ?? IDENTITY, checksShowing }),
    [trouble, api, checksShowing, nodes, edges],
  );
}

/** Inside the drawing's React Flow provider: fits the view to the chain when the panel bumps the token. */
export function TroubleCanvasBridge() {
  const { chain, token } = useTroubleState();
  const api = useChecksApi();
  const rf = useReactFlow();
  useEffect(() => {
    if (chain.size === 0 || token === 0) return;
    const { nodeIds } = matchShown(rf.getNodes(), rf.getEdges(), chain, api?.store.get().canon ?? IDENTITY);
    if (nodeIds.size > 0) void rf.fitView({ nodes: [...nodeIds].map((id) => ({ id })), padding: 0.4, maxZoom: 1.25, duration: 400 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one move per token
  }, [token]);
  return null;
}
