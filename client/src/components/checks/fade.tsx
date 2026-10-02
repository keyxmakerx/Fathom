// Show (ADR-0061 §5): the canvas fades everything but the elements a finding touches, to the phantom 28% a lit
// cable path already uses, and the camera moves to them. Esc, a second Show or a click on empty canvas ends it.
import { useEffect, useMemo } from 'react';
import { useReactFlow, useStoreApi } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';

import { matchShown } from './checksModel';
import { useChecksApi, useChecksShow } from './checksStore';

const withFade = <T extends { className?: string }>(item: T): T => ({ ...item, className: item.className ? `${item.className} checks-faded` : 'checks-faded' });

/** The same arrays, untouched, unless a Show is on. */
export function useChecksFade(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } {
  const api = useChecksApi();
  const show = useChecksShow();
  return useMemo(() => {
    if (api == null || show == null) return { nodes, edges };
    const { nodeIds, edgeIds } = matchShown(nodes, edges, show.keys, api.store.get().canon);
    return {
      nodes: nodes.map((n) => (nodeIds.has(n.id) ? n : withFade(n))),
      edges: edges.map((e) => (edgeIds.has(e.id) ? e : withFade(e))),
    };
  }, [api, show, nodes, edges]);
}

/** Inside the drawing's React Flow provider: moves the camera on Show and listens for the ways out. */
export function ChecksCanvasBridge() {
  const api = useChecksApi();
  const show = useChecksShow();
  const rf = useReactFlow();
  const flow = useStoreApi();

  useEffect(() => {
    if (api == null || show == null) return;
    const { nodeIds } = matchShown(rf.getNodes(), rf.getEdges(), show.keys, api.store.get().canon);
    if (nodeIds.size > 0) void rf.fitView({ nodes: [...nodeIds].map((id) => ({ id })), padding: 0.5, maxZoom: 1.25, duration: 400 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one move per Show click
  }, [show?.token]);

  useEffect(() => {
    if (api == null || show == null) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      api.clearShow();
    };
    const pane = flow.getState().domNode?.querySelector('.react-flow__pane');
    const onPane = () => api.clearShow();
    window.addEventListener('keydown', onKey, true);
    pane?.addEventListener('click', onPane);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      pane?.removeEventListener('click', onPane);
    };
  }, [api, show, flow]);

  return null;
}
