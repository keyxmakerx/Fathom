// "It's down" on the canvas (ADR-0061 troubleshooting). Pure: the chain stays at full strength, everything else
// takes the phantom fade Checks' Show uses, sheath colours drop to ink, the chain's cables carry the lit halo, the
// current step's things are outlined, and what the answers point at wears a tag. Nothing here writes the document.
import type { Edge, Node } from '@xyflow/react';
import type { CSSProperties } from 'react';

import { chassisIdsOf, matchShown, type Canon } from '../checks/checksModel';
import type { TroubleState } from '../troubleshoot/troubleStore';
import { addClass, cssString, withFade } from './plansMarks';

export const SUSPECT_WORD = 'POINTS HERE';

export interface TroubleCanvasInput {
  nodes: Node[];
  edges: Edge[];
  trouble: Pick<TroubleState, 'active' | 'chain' | 'current' | 'suspects'>;
  canon: Canon;
  /** A Checks Show is on: it owns the fade, so the chain does not add its own. */
  checksShowing: boolean;
}

/** The drawn nodes and edges with the session applied. The same arrays, untouched, when none runs. */
export function applyTrouble({ nodes, edges, trouble, canon, checksShowing }: TroubleCanvasInput): { nodes: Node[]; edges: Edge[] } {
  if (!trouble.active) return { nodes, edges };
  const hasChain = trouble.chain.size > 0;
  const keep = hasChain ? matchShown(nodes, edges, trouble.chain, canon) : { nodeIds: new Set<string>(), edgeIds: new Set<string>() };
  const now = trouble.current.size > 0 ? matchShown(nodes, edges, trouble.current, canon) : { nodeIds: new Set<string>(), edgeIds: new Set<string>() };
  const bad = new Set<string>();
  if (trouble.suspects.size > 0) {
    for (const n of nodes) if (chassisIdsOf(n).some((c) => trouble.suspects.has(canon(c)))) bad.add(n.id);
  }
  const fading = hasChain && !checksShowing;
  const outNodes = nodes.map((n) => {
    let out = n;
    if (fading && !keep.nodeIds.has(n.id)) out = withFade(out);
    if (now.nodeIds.has(n.id)) out = { ...out, className: addClass(out.className, 'trouble-current') };
    if (bad.has(n.id)) {
      const style = { ...(out.style as object | undefined), '--trouble-word': cssString(SUSPECT_WORD) } as CSSProperties;
      out = { ...out, className: addClass(out.className, 'trouble-suspect'), style };
    }
    return out;
  });
  const outEdges = edges.map((e) => {
    let out: Edge = { ...e, data: { ...(e.data as object | undefined), troubleInk: true } };
    if (keep.edgeIds.has(e.id)) out = { ...out, data: { ...(out.data as object), troubleLit: true } };
    if (fading && !keep.edgeIds.has(e.id)) out = withFade(out);
    if (now.edgeIds.has(e.id)) out = { ...out, className: addClass(out.className, 'trouble-current') };
    return out;
  });
  return { nodes: outNodes, edges: outEdges };
}
