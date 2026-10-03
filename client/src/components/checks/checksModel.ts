// Pure helpers for the Checks surface (ADR-0061 §5): words, counts, the element -> device map, badges.
import { compatible } from '../../document/compat';
import type { Document } from '../../document/model';
import type { CheckFinding, CheckSeverity, ChecksResult } from '../../engine/engine';
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

/** A canvas narrower than this starts with the panel folded to the bar chip. */
export const NARROW_CANVAS_PX = 720;

/** Whether the panel is open when the user has not chosen: only for refusals and warnings, and only on a canvas
 * wide enough to spare the room. Ideas alone never open it. */
export function defaultOpen(r: Pick<ChecksResult, 'refuse' | 'warn'> | null, canvasWidth: number | null): boolean {
  return r != null && r.refuse + r.warn > 0 && canvasWidth != null && canvasWidth >= NARROW_CANVAS_PX;
}

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

export const UNCHECKED_SOURCE = 'Source not yet checked by a person.';

/** What the Why card prints about a rule's source. A cited source carries the author's working note, which is
 * never shown: the card says it has not been checked by a person. A rule with no cited source has one plain
 * sentence, shown as is. */
export function sourceView(f: CheckFinding): { label: 'Source' | 'Basis'; unchecked: boolean; title: string; linked: boolean; note: string } {
  const { title, note } = f.source;
  if (title === '') return { label: 'Basis', unchecked: false, title: '', linked: false, note };
  return { label: 'Source', unchecked: note !== '', title, linked: hasSourceLink(f), note: '' };
}

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

/** element -> number of refusals and warnings that touch it (ideas are listed in the panel, never badged). One
 * pass per result; a port counts toward its device. */
export function buildBadgeMap(findings: readonly CheckFinding[], canon: Canon): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const f of findings) {
    if (f.severity === 'idea') continue;
    for (const k of involvedKeys(f, canon)) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
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
export function chassisIdsOf(node: FadeNode): string[] {
  const data = node.data as { chassis?: { id: string }; shelf?: { occupants?: { id: string }[] } } | undefined;
  if (node.type === 'chassis' && data?.chassis) return [data.chassis.id];
  if (node.type === 'freeBox' && node.id.startsWith('free:')) return [node.id.slice(5)];
  if (node.type === 'shelf' && data?.shelf?.occupants) return data.shelf.occupants.map((o) => o.id);
  return [];
}

export function cableIdsOf(edge: FadeEdge): string[] {
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

/** Keeps a dragged panel inside its parent. `docked` is the panel's rect with no offset applied (not the live,
 * transformed one), in the parent's coordinates. A panel taller or wider than the room is pinned to the top-left. */
export function clampOffset(parent: Rect, docked: Rect, want: { x: number; y: number }): { x: number; y: number } {
  const axis = (v: number, pStart: number, pSize: number, dStart: number, dSize: number): number => {
    const lo = pStart - dStart;
    const hi = Math.max(lo, pStart + pSize - dSize - dStart);
    return Math.round(Math.min(Math.max(v, lo), hi));
  };
  return {
    x: axis(want.x, parent.left, parent.width, docked.left, docked.width),
    y: axis(want.y, parent.top, parent.height, docked.top, docked.height),
  };
}

/** Where the refusal card goes: beside the pointer, flipped to its other side where it would leave the viewport,
 * and never past the margin. `size` is the card's measured size. */
export function placeCard(
  at: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 12,
  margin = 8,
): { left: number; top: number } {
  const axis = (p: number, len: number, room: number): number => {
    let v = p + gap;
    if (v + len > room - margin) v = p - gap - len;
    return Math.round(Math.max(margin, Math.min(v, room - margin - len)));
  };
  return { left: axis(at.x, size.width, viewport.width), top: axis(at.y, size.height, viewport.height) };
}

/** The padding for Show's camera move: the 50% it always had, plus the room the docked panel takes on the right.
 * `inset` is that room in px (0 when the panel is folded or has been moved off its dock). */
type Px = `${number}px`;
export function showPadding(inset: number, width: number, height: number): number | { top: Px; right: Px; bottom: Px; left: Px } {
  if (!(inset > 0)) return 0.5;
  const base = (len: number): number => Math.floor((len - len / 1.5) * 0.5);
  const px = (n: number): Px => `${n}px`;
  return { top: px(base(height)), bottom: px(base(height)), left: px(base(width)), right: px(base(width) + Math.round(inset)) };
}

/** What one Esc closes: the topmost of the refusal card, a running Show, the Why card. */
export function escTarget(open: { refusal: boolean; show: boolean; why: boolean }): 'refusal' | 'show' | 'why' | null {
  if (open.refusal) return 'refusal';
  if (open.show) return 'show';
  if (open.why) return 'why';
  return null;
}

/** An element Esc belongs to (typing, a select), not to Checks. */
export function isTypingTarget(el: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (el == null) return false;
  const tag = (el.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/** Quiet time after the last document change before the standing checks run, at the least. */
export const CHECKS_DEBOUNCE_MS = 300;
export const CHECKS_DEBOUNCE_CAP_MS = 10_000;
/** The standing run waits this many times the last measured load of the module. */
export const CHECKS_DEBOUNCE_FACTOR = 5;
/** Above this last-measured load cost the gesture guard does not reload the module on the interaction path. */
export const GUARD_RELOAD_LIMIT_MS = 800;

/** How long the document must stay quiet before the standing checks run: max(300 ms, 5 x last load), capped. */
export function standingDelay(lastLoadMs: number | null): number {
  const cost = lastLoadMs != null && Number.isFinite(lastLoadMs) && lastLoadMs > 0 ? lastLoadMs : 0;
  return Math.min(CHECKS_DEBOUNCE_CAP_MS, Math.max(CHECKS_DEBOUNCE_MS, CHECKS_DEBOUNCE_FACTOR * cost));
}

/** May the gesture guard bring the module up to date first? Not when that has been measured to cost too much. */
export const guardMayReload = (lastLoadMs: number | null): boolean => lastLoadMs == null || !(lastLoadMs > GUARD_RELOAD_LIMIT_MS);

interface GestureChecker {
  checkCable(near: { port: string }, far: { port: string }, media: string): CheckFinding[];
}

/** The first refusal a cable would cause, or null: no mirror, no refusal, or the checks failing all mean go ahead. */
export function firstRefusal(mirror: GestureChecker | null, from: string, to: string, medias: readonly string[]): CheckFinding | null {
  if (mirror == null) return null;
  try {
    for (const media of medias) {
      const hit = mirror.checkCable({ port: from }, { port: to }, media).find((r) => r.severity === 'refuse');
      if (hit != null) return hit;
    }
  } catch {
    // The checks never block a drawing.
  }
  return null;
}
