// Pure helpers for the Checks surface (ADR-0061 §5): words, counts, the element -> device map, badges.
import type { CheckFinding, CheckSeverity, ChecksResult } from '../../engine/engine';
import { compatible } from '../../document/compat';
import type { Document } from '../../document/model';
import type { ClosetView } from '../drawing/contract';
import { locatePort } from '../drawing/lookup';

/** A word and a glyph per severity, never a colour (UI-SPEC "Look"). */
export const SEVERITY: Record<CheckSeverity, { word: string; glyph: string }> = {
  refuse: { word: "Can't work", glyph: '✕' },
  warn: { word: 'Warning', glyph: '▲' },
  idea: { word: 'Idea', glyph: '○' },
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "2 warnings · 1 idea"; empty when there is nothing to count. */
export function summaryText(r: Pick<ChecksResult, 'refuse' | 'warn' | 'idea'>): string {
  const parts: string[] = [];
  if (r.refuse > 0) parts.push(`${r.refuse} can't work`);
  if (r.warn > 0) parts.push(plural(r.warn, 'warning', 'warnings'));
  if (r.idea > 0) parts.push(plural(r.idea, 'idea', 'ideas'));
  return parts.join(' · ');
}

export const totalCount = (r: Pick<ChecksResult, 'refuse' | 'warn' | 'idea'>): number => r.refuse + r.warn + r.idea;

/** The lines the panel prints under the summary, in the order it prints them. */
export function panelNotes(r: ChecksResult): string[] {
  const notes: string[] = [];
  if (r.loadFailed) notes.push('Checks are off: a rule failed to load');
  if (r.unfinished > 0) notes.push(`${plural(r.unfinished, 'check', 'checks')} could not finish`);
  if (!r.loadFailed && r.rulesLoaded > 0 && r.findings.length === 0) notes.push('No problems found');
  return notes;
}

export const findingKey = (f: CheckFinding): string => `${f.rule}|${f.elements.map((e) => e.id).join(',')}`;

/** A name worth printing above a finding: not the engine's placeholders. */
export function anchorName(f: CheckFinding): string {
  const name = f.elements[0]?.name ?? '';
  return name === '—' || name === '(unlabelled)' ? '' : name;
}

/** `source` as text for the Why card: a title and a link only when there is one. */
export const hasSourceLink = (f: CheckFinding): boolean => /^https?:\/\//.test(f.source.url);

/** Maps any element id to the device that owns it (a port to its chassis to its device); others to themselves. */
export type Canon = (id: string) => string;

const NO_CANON: Canon = (id) => id;

export function buildCanon(doc: Document): Canon {
  const parent = new Map<string, string>();
  for (const e of doc.edges) {
    if (e.absentSince === undefined && (e.id.startsWith('has-') || e.id.startsWith('fitted-in:'))) parent.set(e.to, e.from);
  }
  if (parent.size === 0) return NO_CANON;
  return (id) => {
    let at = id;
    for (let i = 0; i < 8 && !at.startsWith('device:'); i += 1) {
      const up = parent.get(at);
      if (up === undefined) break;
      at = up;
    }
    return at.startsWith('device:') ? at : id;
  };
}

/** The canonical ids a finding touches, once each. */
export function involvedKeys(f: CheckFinding, canon: Canon): Set<string> {
  const keys = new Set<string>();
  for (const e of f.elements) if (e.id !== '') keys.add(canon(e.id));
  return keys;
}

/** element -> number of findings that touch it. One pass per result; a port counts toward its device. */
export function buildBadgeMap(findings: readonly CheckFinding[], canon: Canon): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const f of findings) for (const k of involvedKeys(f, canon)) counts.set(k, (counts.get(k) ?? 0) + 1);
  return counts;
}

interface FadeNode {
  id: string;
  type?: string;
  data?: unknown;
}
interface FadeEdge {
  id: string;
  source?: string;
  target?: string;
  data?: unknown;
}

/** The chassis ids a node stands for: a plate, a free box, or a shelf's occupants. */
function chassisIdsOf(node: FadeNode): string[] {
  const data = node.data as { chassis?: { id: string }; shelf?: { occupants?: { id: string }[] } } | undefined;
  if (node.type === 'chassis' && data?.chassis) return [data.chassis.id];
  if (node.type === 'freeBox' && node.id.startsWith('free:')) return [node.id.slice(5)];
  if (node.type === 'shelf' && data?.shelf?.occupants) return data.shelf.occupants.map((o) => o.id);
  return [];
}

function cableIdsOf(edge: FadeEdge): string[] {
  const data = edge.data as { cable?: { id: string }; bundle?: { members?: { id: string }[] } } | undefined;
  if (data?.bundle?.members) return data.bundle.members.map((m) => m.id);
  return [data?.cable?.id ?? edge.id];
}

/** Which drawn nodes and edges a Show keeps at full strength: those holding an involved element, a cable's
 * two end nodes included. Everything else takes the phantom fade. */
export function matchShown(
  nodes: readonly FadeNode[],
  edges: readonly FadeEdge[],
  keys: ReadonlySet<string>,
  canon: Canon,
): { nodeIds: Set<string>; edgeIds: Set<string> } {
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const n of nodes) if (chassisIdsOf(n).some((c) => keys.has(canon(c)))) nodeIds.add(n.id);
  for (const e of edges) {
    if (cableIdsOf(e).some((c) => keys.has(c))) {
      edgeIds.add(e.id);
      if (e.source) nodeIds.add(e.source);
      if (e.target) nodeIds.add(e.target);
    }
  }
  return { nodeIds, edgeIds };
}

/** The media a drawn lead could be, for a gesture the drawing is about to refuse or accept. A compatible pair
 * has one; an incompatible one has what each end's own natural lead would be, and the card names the first that
 * refuses. A guess for an explanation only: it never reaches the document. */
export function mediaCandidates(view: ClosetView, fromPortId: string, toPortId: string): string[] {
  const from = locatePort(view, fromPortId)?.port.connector;
  const to = locatePort(view, toPortId)?.port.connector;
  if (from == null || to == null) return [''];
  const pair = compatible(from, to);
  if (pair.ok) return [pair.media];
  const natural = (c: string): string | null => {
    const probe = compatible(c, c);
    return probe.ok && probe.media !== 'power' ? probe.media : null;
  };
  const found = [natural(from), natural(to)].filter((m): m is string => m != null);
  return found.length > 0 ? [...new Set(found)] : [''];
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Keeps a dragged panel inside its parent, its header always reachable. `docked` is the panel's rect at offset 0. */
export function clampOffset(parent: Rect, docked: Rect, want: { x: number; y: number }, headerPx = 36): { x: number; y: number } {
  const minX = parent.left - docked.left;
  const maxX = parent.left + parent.width - docked.width - docked.left;
  const minY = parent.top - docked.top;
  const maxY = parent.top + parent.height - headerPx - docked.top;
  return {
    x: Math.round(Math.min(Math.max(want.x, Math.min(minX, maxX)), Math.max(minX, maxX))),
    y: Math.round(Math.min(Math.max(want.y, Math.min(minY, maxY)), Math.max(minY, maxY))),
  };
}
