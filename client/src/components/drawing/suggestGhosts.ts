// The open suggestions card's ticked cables as dashed lines, drawn by the plan's ghost edge with no tag.
import { useMemo, useRef } from 'react';
import type { Edge, Node } from '@xyflow/react';

import type { Canon } from '../checks/checksModel';
import { useChecksApi } from '../checks/checksStore';
import type { PlanMark } from '../plans/plansStore';
import { useSuggestedLines, type SuggestedLine } from '../suggest/suggestStore';
import { ghostEdges, type ResolvePort } from './plansMarks';

const IDENTITY: Canon = (id) => id;

/** The suggested lines as plan add-cable marks with an empty word, so they draw dashed with no tag. */
export function suggestMarks(lines: readonly SuggestedLine[]): PlanMark[] {
  return lines.map((l, i) => ({ stepId: `suggest:${l.key}`, ordinal: i, kind: 'add-cable', keys: [], ends: [l.ends[0], l.ends[1]], word: '' }));
}

/** The same edges, untouched, unless a suggestions card has ticked cables. */
export function useSuggestGhosts(nodes: Node[], edges: Edge[], resolvePort?: ResolvePort): Edge[] {
  const lines = useSuggestedLines();
  const api = useChecksApi();
  const resolveRef = useRef(resolvePort);
  resolveRef.current = resolvePort;
  return useMemo(() => {
    if (lines.length === 0) return edges;
    const ghosts = ghostEdges('planned', suggestMarks(lines), nodes, api?.store.get().canon ?? IDENTITY, (id) => resolveRef.current?.(id) ?? null);
    return ghosts.length === 0 ? edges : [...edges, ...ghosts];
  }, [lines, api, nodes, edges]);
}
