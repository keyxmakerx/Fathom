// Maintenance plan marks on the canvas (ADR-0061 round 7). Pure: which nodes and cables a mark touches, the
// ghost edge for a cable that does not exist yet, and the fade for a focus. Nothing here writes the document;
// everything is added to the rendered node and edge lists only.
import type { Edge, Node } from '@xyflow/react';

import { cableIdsOf, chassisIdsOf, matchShown, type Canon } from '../checks/checksModel';
import type { PlanMark, PlansState } from '../plans/plansStore';
import type { PlanStage } from '../../document/plans';
import type { PortPoint } from './cableEnds';
import { lineSides, type Rect } from './freeLayout';

/** Indigo while planning, teal in Do (the current step, and filled once done), ink once recorded. */
export type PlanTone = 'plan' | 'do' | 'record' | 'done';

export const TONE_COLOUR: Record<PlanTone, string> = {
  plan: 'var(--m-plan)',
  do: 'var(--m-do)',
  record: 'var(--ink)',
  done: 'var(--m-do)',
};

export function toneOf(stage: PlanStage, word: string): PlanTone {
  if (stage === 'recorded') return 'record';
  if (stage === 'doing') return /^[✓≠]/.test(word) ? 'done' : 'do';
  return 'plan';
}

/** What a node or cable is drawn with: its tone and its tag. Dashed only for an open plan's indigo marks. */
export interface PlanDecor {
  tone: PlanTone;
  word: string;
  dashed: boolean;
}

/** Doing: the step being done wins over the ones before it. */
const isCurrentWord = (word: string): boolean => /^STEP\b/.test(word);

/** The decoration for the marks that touch one thing: the lead step's word (the current step in Do, else the
 * lowest), `+n` for the others. */
export function decorFor(stage: PlanStage, marks: readonly PlanMark[]): PlanDecor {
  const sorted = [...marks].sort((a, b) => a.ordinal - b.ordinal);
  const lead = stage === 'doing' ? sorted.find((m) => isCurrentWord(m.word)) : undefined;
  const first = lead ?? sorted[0]!;
  const tone = toneOf(stage, first.word);
  const word = sorted.length > 1 ? `${first.word} +${sorted.length - 1}` : first.word;
  return { tone, word, dashed: tone === 'plan' };
}

/** What an edge carries when a mark touches it (read by CableEdge, BundleEdge and the ghost). */
export interface PlanEdgeMark {
  tone: PlanTone;
  word: string;
  dashed: boolean;
}

export interface PlanGhostData extends Record<string, unknown> {
  planMark: PlanEdgeMark;
  /** The mark's keys, so a focus keeps the ghost at full strength. */
  planKeys: readonly string[];
  /** Each end's port box in flow space, so the line leaves the plate where the port is. */
  ends?: [PortPoint | null, PortPoint | null];
  checksFaded?: boolean;
}

export const GHOST_EDGE_TYPE = 'planGhost';
export const GHOST_ID_PREFIX = 'plan-ghost:';

/** Where a port id lands in the drawn graph; supplied by the drawing, which knows its own handles. */
export interface PortTarget {
  nodeId: string;
  handleId: string;
  box: PortPoint | null;
}
export type ResolvePort = (portId: string) => PortTarget | null;

/** key -> marks, so a node or cable looks its marks up rather than scanning them all. */
function indexByKey(marks: readonly PlanMark[]): Map<string, PlanMark[]> {
  const byKey = new Map<string, PlanMark[]>();
  for (const m of marks) {
    for (const k of m.keys) {
      const list = byKey.get(k);
      if (list) list.push(m);
      else byKey.set(k, [m]);
    }
  }
  return byKey;
}

const unique = (marks: PlanMark[]): PlanMark[] => [...new Set(marks)];

/** Which drawn nodes and cable edges a mark touches, with the marks that do. A device mark takes the plate, free
 * box or shelf holding it; a cable mark takes its cable (or the bundle holding it). */
export function matchMarks(
  nodes: readonly Node[],
  edges: readonly Edge[],
  marks: readonly PlanMark[],
  canon: Canon,
): { nodes: Map<string, PlanMark[]>; edges: Map<string, PlanMark[]> } {
  const byKey = indexByKey(marks);
  const hitNodes = new Map<string, PlanMark[]>();
  const hitEdges = new Map<string, PlanMark[]>();
  if (byKey.size === 0) return { nodes: hitNodes, edges: hitEdges };
  for (const n of nodes) {
    const found = chassisIdsOf(n).flatMap((c) => byKey.get(canon(c)) ?? []);
    if (found.length > 0) hitNodes.set(n.id, unique(found));
  }
  for (const e of edges) {
    const found = cableIdsOf(e).flatMap((c) => byKey.get(c) ?? []);
    if (found.length > 0) hitEdges.set(e.id, unique(found));
  }
  return { nodes: hitNodes, edges: hitEdges };
}

const DEFAULT_BOX: Rect = { x: 0, y: 0, w: 128, h: 56 };

function rectOfNode(n: Node): Rect {
  const w = n.measured?.width ?? n.width ?? DEFAULT_BOX.w;
  const h = n.measured?.height ?? n.height ?? DEFAULT_BOX.h;
  return { x: n.position.x, y: n.position.y, w, h };
}

/** Dashed ghost edges for the add-cable marks: a cable that is in the plan and not in the graph. Each end is
 * the port's own plate where the drawing has it, else the device's box (the Diagram look has no ports). */
export function ghostEdges(
  stage: PlanStage,
  marks: readonly PlanMark[],
  nodes: readonly Node[],
  canon: Canon,
  resolve: ResolvePort | undefined,
): Edge[] {
  const out: Edge[] = [];
  const nodeIds = new Set(nodes.map((n) => n.id));
  const nodeOfDevice = (key: string): Node | undefined => {
    const boxes = nodes.filter((n) => chassisIdsOf(n).some((c) => canon(c) === key));
    return boxes.find((n) => n.type === 'freeBox') ?? boxes[0];
  };
  for (const m of marks) {
    if (m.kind !== 'add-cable' || m.ends == null) continue;
    // Marked steps have no ghost: the real cable carries the mark, or none was made.
    if (/^[✓≠]/.test(m.word)) continue;
    const [pa, pb] = m.ends;
    const ta = resolve?.(pa) ?? null;
    const tb = resolve?.(pb) ?? null;
    let source: { nodeId: string; handleId?: string };
    let target: { nodeId: string; handleId?: string };
    let ends: [PortPoint | null, PortPoint | null] | undefined;
    if (ta != null && tb != null && nodeIds.has(ta.nodeId) && nodeIds.has(tb.nodeId)) {
      source = { nodeId: ta.nodeId, handleId: ta.handleId };
      target = { nodeId: tb.nodeId, handleId: tb.handleId };
      ends = ta.box != null || tb.box != null ? [ta.box, tb.box] : undefined;
    } else {
      const na = nodeOfDevice(canon(pa));
      const nb = nodeOfDevice(canon(pb));
      if (na == null || nb == null || na.id === nb.id) continue;
      source = { nodeId: na.id };
      target = { nodeId: nb.id };
      if (na.type === 'freeBox' && nb.type === 'freeBox') {
        const sides = lineSides(rectOfNode(na), rectOfNode(nb));
        source.handleId = sides.a;
        target.handleId = sides.b;
      }
    }
    const tone = toneOf(stage, m.word);
    const data: PlanGhostData = { planMark: { tone, word: m.word, dashed: tone === 'plan' }, planKeys: m.keys, ends };
    out.push({
      id: `${GHOST_ID_PREFIX}${m.stepId}`,
      type: GHOST_EDGE_TYPE,
      source: source.nodeId,
      sourceHandle: source.handleId,
      target: target.nodeId,
      targetHandle: target.handleId,
      selectable: false,
      focusable: false,
      deletable: false,
      zIndex: 5,
      data,
    });
  }
  return out;
}

/** Adds `cls` unless the class list has it already, so two fades never print the class twice. */
export function addClass(existing: string | undefined, cls: string): string {
  if (!existing) return cls;
  return existing.split(/\s+/).includes(cls) ? existing : `${existing} ${cls}`;
}

const FADED = 'checks-faded';

/** The same phantom fade Checks' Show uses: the class, and `checksFaded` so a cable does not dim itself again. */
export function withFade<T extends { className?: string; data?: unknown }>(item: T): T {
  return { ...item, className: addClass(item.className, FADED), data: { ...(item.data as object | undefined), checksFaded: true } };
}

function withDecor<T extends { className?: string; style?: unknown }>(item: T, decor: PlanDecor, isNode: boolean): T {
  const className = addClass(item.className, `plan-mark plan-mark--${decor.tone}${decor.dashed ? ' plan-mark--dashed' : ''}`);
  if (isNode) {
    // The tag is the node's ::after; its text comes through a custom property.
    const style = { ...(item.style as object | undefined), '--plan-word': cssString(decor.word) };
    return { ...item, className, style };
  }
  return { ...item, className };
}

/** A CSS string literal with nothing in it that could end the string early. */
export function cssString(text: string): string {
  return `"${text.replace(/[\\"\n\r]/g, ' ')}"`;
}

/** Which drawn nodes and edges a focus keeps at full strength: Checks' own match, plus a ghost only when both
 * its ends are in the focus (so a later step's cable is not kept for sharing one device). */
export function focusMatch(
  nodes: readonly Node[],
  edges: readonly Edge[],
  focus: ReadonlySet<string>,
  canon: Canon,
): { nodeIds: Set<string>; edgeIds: Set<string> } {
  const { nodeIds, edgeIds } = matchShown(nodes, edges, focus, canon);
  for (const e of edges) {
    if (!e.id.startsWith(GHOST_ID_PREFIX)) continue;
    const keys = (e.data as Partial<PlanGhostData> | undefined)?.planKeys ?? [];
    if (keys.length === 0 || !keys.every((k) => focus.has(k))) continue;
    edgeIds.add(e.id);
    nodeIds.add(e.source);
    nodeIds.add(e.target);
  }
  return { nodeIds, edgeIds };
}

export interface PlansCanvasInput {
  nodes: Node[];
  edges: Edge[];
  plans: Pick<PlansState, 'stage' | 'marks' | 'focus'>;
  canon: Canon;
  resolvePort?: ResolvePort;
  /** A Checks Show is on: it owns the fade, so the plan's focus does not add its own. */
  checksShowing: boolean;
}

/** The drawn nodes and edges with the open plan's marks, ghost edges and focus fade applied. The same arrays,
 * untouched, when there is nothing to draw. */
export function applyPlans({ nodes, edges, plans, canon, resolvePort, checksShowing }: PlansCanvasInput): { nodes: Node[]; edges: Edge[] } {
  const { stage, marks, focus } = plans;
  const fading = focus != null && !checksShowing;
  if (stage == null && !fading) return { nodes, edges };
  if (stage != null && marks.length === 0 && !fading) return { nodes, edges };

  let outNodes: Node[] = nodes;
  let outEdges: Edge[] = edges;
  if (stage != null && marks.length > 0) {
    const hit = matchMarks(nodes, edges, marks, canon);
    if (hit.nodes.size > 0)
      outNodes = nodes.map((n) => {
      const m = hit.nodes.get(n.id);
        return m ? withDecor(n, decorFor(stage, m), true) : n;
      });
    if (hit.edges.size > 0)
      outEdges = edges.map((e) => {
        const m = hit.edges.get(e.id);
        if (!m) return e;
        const decor = decorFor(stage, m);
        return { ...withDecor(e, decor, false), data: { ...(e.data as object | undefined), planMark: decor } };
      });
    const ghosts = ghostEdges(stage, marks, nodes, canon, resolvePort);
    if (ghosts.length > 0) outEdges = [...outEdges, ...ghosts];
  }
  if (fading) {
    const keep = focusMatch(outNodes, outEdges, focus, canon);
    outNodes = outNodes.map((n) => (keep.nodeIds.has(n.id) ? n : withFade(n)));
    outEdges = outEdges.map((e) => (keep.edgeIds.has(e.id) ? e : withFade(e)));
  }
  return { nodes: outNodes, edges: outEdges };
}
