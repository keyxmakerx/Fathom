// Where each other person's initials dot goes on the canvas: the top-right of
// the first thing they have selected (UI-SPEC "Presence"). Pure.

import type { Person } from '../../api/live';

export interface MarkNode {
  id: string;
  position: { x: number; y: number };
  width?: number | null;
}

export interface PeerMark {
  account: string;
  initials: string;
  name: string;
  /** Flow-space top-left of the dot. */
  x: number;
  y: number;
}

export const PEER_DOT_PX = 20;

/** `nodeIdsFor` names the nodes an element may be drawn as, in order. A person whose selection is not on the canvas gets no dot. */
export function peerMarks(
  nodes: readonly MarkNode[],
  peers: readonly Person[],
  nodeIdsFor: (elementId: string) => readonly string[],
): PeerMark[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const stacked = new Map<string, number>();
  const out: PeerMark[] = [];
  for (const p of peers) {
    if (!p.selected) continue;
    const node = nodeIdsFor(p.selected).map((id) => byId.get(id)).find((n) => n !== undefined);
    if (!node || !node.width) continue;
    const n = stacked.get(node.id) ?? 0;
    stacked.set(node.id, n + 1);
    out.push({
      account: p.account,
      initials: p.initials,
      name: p.name,
      x: node.position.x + node.width - PEER_DOT_PX - 2 - n * (PEER_DOT_PX + 2),
      y: node.position.y + 2,
    });
  }
  return out;
}
