// The path on the canvas: everything the trace does not touch takes the phantom fade (as Checks' Show does), the
// path's cables draw heavier, and each hop gets a numbered ink circle. No colour.
import { useMemo } from 'react';
import { ViewportPortal, useNodes, useReactFlow } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';

import { matchShown, type Canon } from '../checks/checksModel';
import { useChecksApi } from '../checks/checksStore';
import { pathKeys } from './traceModel';
import { useTraceResult } from './traceStore';

const identity: Canon = (id) => id;

const withClass = <T extends { className?: string; data?: unknown }>(item: T, cls: string, data?: object): T => ({
  ...item,
  className: item.className ? `${item.className} ${cls}` : cls,
  ...(data ? { data: { ...(item.data as object | undefined), ...data } } : {}),
});

/** The same arrays, untouched, unless a trace is showing. */
export function useTraceFade(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } {
  const result = useTraceResult();
  const checks = useChecksApi();
  return useMemo(() => {
    if (result == null) return { nodes, edges };
    const canon = checks?.store.get().canon ?? identity;
    const keys = pathKeys(result, canon);
    if (keys.size === 0) return { nodes, edges };
    const { nodeIds, edgeIds } = matchShown(nodes, edges, keys, canon);
    return {
      nodes: nodes.map((n) => (nodeIds.has(n.id) ? n : withClass(n, 'trace-faded', { checksFaded: true }))),
      edges: edges.map((e) => (edgeIds.has(e.id) ? withClass(e, 'trace-path') : withClass(e, 'trace-faded', { checksFaded: true }))),
    };
  }, [result, checks, nodes, edges]);
}

interface Spot {
  n: string;
  x: number;
  y: number;
}

/** Inside the drawing's React Flow: one numbered circle per hop, on the device's corner or the cable's middle. */
export function TraceBadges() {
  const result = useTraceResult();
  if (result == null) return null;
  return <Badges />;
}

function Badges() {
  const result = useTraceResult()!;
  const checks = useChecksApi();
  const rf = useReactFlow();
  const nodes = useNodes();
  const spots = useMemo(() => {
    const canon = checks?.store.get().canon ?? identity;
    const edges = rf.getEdges();
    const rect = (id: string) => {
      const n = rf.getInternalNode(id);
      const p = n?.internals.positionAbsolute;
      if (n == null || p == null) return null;
      return { x: p.x, y: p.y, w: n.measured.width ?? 0, h: n.measured.height ?? 0 };
    };
    const placed = new Map<string, Spot>();
    const put = (n: number, x: number, y: number) => {
      const k = `${Math.round(x)},${Math.round(y)}`;
      const at = placed.get(k);
      if (at) at.n = `${at.n}·${n}`;
      else placed.set(k, { n: String(n), x, y });
    };
    for (const hop of result.hops) {
      if (hop.kind === 'stop') continue;
      const key = hop.kind === 'cable' ? (hop.nodes[1] ?? '') : canon(hop.nodes[0] ?? '');
      if (key === '') continue;
      const { nodeIds, edgeIds } = matchShown(nodes, edges, new Set([hop.kind === 'cable' ? key : canon(key)]), canon);
      if (hop.kind === 'cable' && edgeIds.size > 0) {
        const e = edges.find((x) => edgeIds.has(x.id));
        const a = e?.source ? rect(e.source) : null;
        const b = e?.target ? rect(e.target) : null;
        if (a && b) put(hop.n, (a.x + a.w / 2 + b.x + b.w / 2) / 2, (a.y + a.h / 2 + b.y + b.h / 2) / 2);
        continue;
      }
      const first = [...nodeIds][0];
      const r = first ? rect(first) : null;
      if (r) put(hop.n, r.x, r.y);
    }
    return [...placed.values()];
  }, [result, checks, rf, nodes]);
  return (
    <ViewportPortal>
      {spots.map((s, i) => (
        <span key={`${s.n}-${i}`} className="trace-dot" data-testid="trace-dot" style={{ transform: `translate(${s.x}px, ${s.y}px) translate(-50%, -50%)` }}>
          {s.n}
        </span>
      ))}
    </ViewportPortal>
  );
}
