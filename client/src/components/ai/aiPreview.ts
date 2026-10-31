// An AI idea's proposed change on the canvas before anyone accepts it (owner, 2026-10-27: an AI never changes a
// design itself; its change shows the way a plan does, in the plan colour, and the person accepts it). The ideas
// panel writes the store; the drawing only reads it. Nothing here is in the document.
import { createContext, useContext, useSyncExternalStore } from 'react';

import type { AiIdea, IdeaPreview } from '../../api/ai';
import { applyChange, type Change } from '../../document/change';
import { asString, edgesIn, fieldValue, findEdge, findNode, parseNodeId, type Document } from '../../document/model';
import { readPlan, type Plan } from '../../document/plans';
import { buildCanon, type Canon } from '../checks/checksModel';
import type { PlanMark } from '../plans/plansStore';

export interface AiPreviewState {
  /** The idea being shown, or null when the canvas is drawn as it is. */
  ideaId: string | null;
  marks: readonly PlanMark[];
  /** What the marks touch, kept at full strength while the rest fades. */
  focus: ReadonlySet<string> | null;
  /** The design with the idea's change made on a copy, for the canvas to draw what it adds; null while it is
   * being built, when the server could not build it, or when it no longer applies. */
  doc: Document | null;
  /** The marks' keys are canonical under this, the drawn copy's; null for the design's own. */
  canon: Canon | null;
  /** The parts inside a device the idea adds, changes or removes (a card, a port, a power supply), outlined on
   * the plate where it draws them; the device itself carries an INSIDE tag. */
  parts: ReadonlySet<string>;
  /** The maintenance plans the idea adds or changes, read off the drawn copy: a plan has nothing of its own on the
   * canvas, so the ideas panel lists its steps. */
  plans: readonly Plan[];
}

/** What the canvas draws for an idea whose change was built: the design with it made, and the marks on it. */
export interface DrawnPreview {
  doc: Document;
  marks: PlanMark[];
  canon: Canon;
  parts: ReadonlySet<string>;
  plans: readonly Plan[];
}

export interface AiPreviewStore {
  get(): AiPreviewState;
  /** Shows `idea`, drawn on `drawn` when its change was built, else as outlines on what it names, a part inside a
   * device found under `canon`. */
  show(idea: AiIdea | null, drawn?: DrawnPreview | null, canon?: Canon): void;
  subscribe(listener: () => void): () => void;
}

const NONE: AiPreviewState = { ideaId: null, marks: [], focus: null, doc: null, canon: null, parts: new Set(), plans: [] };
const IDENTITY: Canon = (id) => id;

/** A link end the reading named (kind:ULID), rather than a name the change gave something new. */
const isId = (end: string): boolean => /^[a-z-]+:[0-9A-HJKMNP-TV-Z]{26}$/.test(end);

/** The tags on the canvas: what Accept and apply would do to each thing. */
export const PREVIEW_WORDS = {
  change: 'AI CHANGES',
  remove: 'AI REMOVES',
  add: 'AI ADDS',
  // On a device whose cards, ports or power supplies the idea touches: nothing of them shows from outside.
  changeInside: 'AI CHANGES INSIDE',
  removeInside: 'AI REMOVES INSIDE',
  addInside: 'AI ADDS INSIDE',
  // On a device a maintenance plan the idea adds or changes works on: the plan itself is not drawn.
  plans: 'AI PLANS',
} as const;

type Doing = 'add' | 'change' | 'remove';
const INSIDE_WORD: Record<Doing, string> = { add: PREVIEW_WORDS.addInside, change: PREVIEW_WORDS.changeInside, remove: PREVIEW_WORDS.removeInside };

/** The device `id` sits inside, when it is a part of one (a card, a port, a power supply) rather than the device or
 * its chassis, which the canvas draws as the box itself. */
function deviceHolding(canon: Canon, id: string): string | null {
  if (id.startsWith('device:') || id.startsWith('chassis:')) return null;
  const device = canon(id);
  return device !== id && device.startsWith('device:') ? device : null;
}

/** The edges that seat one thing in another; `checksModel.buildCanon` walks the same ones up to the device. */
const SEATS = /^(has-|fitted-in:|on-card:)/;

/** Parts inside devices, by device: one tag each, the one thing done when it is one, else CHANGES. */
class Insides {
  private readonly parts = new Map<string, string>();
  private readonly doing = new Map<string, Set<Doing>>();
  /** Takes `id` when it is a part inside a device; false when it is a thing of its own. */
  take(canon: Canon, id: string, doing: Doing): boolean {
    const device = deviceHolding(canon, id);
    if (device == null) return false;
    this.parts.set(id, device);
    const set = this.doing.get(device) ?? new Set<Doing>();
    set.add(doing);
    this.doing.set(device, set);
    return true;
  }
  /** The INSIDE tags and the parts to outline, skipping a device that is itself marked (added or removed whole). */
  finish(skip: ReadonlySet<string>, step: () => { stepId: string; ordinal: number }): { marks: PlanMark[]; parts: Set<string> } {
    const marks: PlanMark[] = [];
    for (const [device, set] of this.doing) {
      if (skip.has(device)) continue;
      const word = set.size === 1 ? INSIDE_WORD[[...set][0]!] : PREVIEW_WORDS.changeInside;
      marks.push({ ...step(), kind: 'touch', keys: [device], word });
    }
    const parts = new Set([...this.parts].filter(([, device]) => !skip.has(device)).map(([id]) => id));
    return { marks, parts };
  }
}

/** The marks for a preview: an outline on what it changes, a greyed outline on what it removes (a cable it removes
 * is cut), and a dashed line for a link between two things already there. What it adds is drawn only once the
 * change is built (`drawnPreview`). */
export function previewMarks(ideaId: string, preview: IdeaPreview, canon: Canon = IDENTITY): PlanMark[] {
  return previewOutlines(ideaId, preview, canon).marks;
}

function previewOutlines(ideaId: string, preview: IdeaPreview, canon: Canon): { marks: PlanMark[]; parts: ReadonlySet<string> } {
  const marks: PlanMark[] = [];
  let n = 0;
  const step = (): { stepId: string; ordinal: number } => ({ stepId: `ai:${ideaId}:${n}`, ordinal: n++ });
  const insides = new Insides();
  const whole = new Set<string>();
  for (const id of preview.changes) {
    if (!insides.take(canon, id, 'change')) marks.push({ ...step(), kind: 'touch', keys: [id], word: PREVIEW_WORDS.change });
  }
  for (const id of preview.removes) {
    if (insides.take(canon, id, 'remove')) continue;
    if (id.startsWith('device:')) whole.add(id);
    marks.push({ ...step(), kind: id.startsWith('cable:') ? 'cut-cable' : 'touch', keys: [id], word: PREVIEW_WORDS.remove, removed: true });
  }
  const inside = insides.finish(whole, step);
  marks.push(...inside.marks);
  for (const l of preview.links)
    if (isId(l.from) && isId(l.to)) marks.push({ ...step(), kind: 'add-cable', keys: [l.from, l.to], ends: [l.from, l.to], word: PREVIEW_WORDS.add });
  return { marks, parts: inside.parts };
}

/** The design with the idea's change made, and its marks: an outline on everything the change adds (a chassis in
 * its rack, a cable between its ports) and on what it changes, what it removes left in place and greyed. Null when
 * the change does not apply to this copy of the design. */
export function drawnPreview(doc: Document, idea: AiIdea, change: Change): DrawnPreview | null {
  const removing = change.batch.ops.filter((op) => op.type === 'tombstone').map((op) => op.element);
  // What it removes stays drawn, greyed, rather than vanishing.
  const kept: Change = { ...change, batch: { ...change.batch, ops: change.batch.ops.filter((op) => op.type !== 'tombstone') } };
  let drawn: Document;
  try {
    drawn = applyChange(doc, kept);
  } catch {
    return null;
  }
  const canon = buildCanon(drawn);
  const key = (id: string): string => (findEdge(drawn, id) ? id : canon(id));
  const gone = new Set(removing);
  const insides = new Insides();
  // The edge that seats a part (a card in its slot, a port on its card) is that part's, not a thing of its own.
  const take = (id: string, doing: Doing): boolean => {
    const seat = findEdge(drawn, id) ?? findEdge(doc, id);
    return insides.take(canon, seat != null && SEATS.test(seat.id) ? seat.to : id, doing);
  };
  const fresh = new Set<string>();
  const added = new Set<string>();
  const changed = new Set<string>();
  const removed: string[] = [];
  // A plan, its steps and the edges between them draw nothing: the devices the plan works on carry its tag instead.
  const plans = new Set<string>();
  const planThing = (id: string): boolean => {
    const plan = planHolding(drawn, id) ?? planHolding(doc, id);
    if (plan == null) return false;
    if (!gone.has(plan)) plans.add(plan);
    return true;
  };
  for (const op of change.batch.ops) {
    if (op.type === 'add_node' && planThing(op.node)) {
      fresh.add(op.node);
      continue;
    }
    if (op.type === 'add_edge' && planThing(op.edge)) continue;
    if (op.type === 'add_node') {
      fresh.add(op.node);
      if (!take(op.node, 'add')) added.add(key(op.node));
    } else if (op.type === 'add_edge') {
      if (!take(op.edge, 'add')) added.add(op.edge);
    }
  }
  for (const op of change.batch.ops) {
    // What it adds is filled in as it is added; that is not a change as well.
    if (op.type !== 'set_field' || gone.has(op.element) || fresh.has(op.element)) continue;
    if (planThing(op.element) || take(op.element, 'change')) continue;
    const k = key(op.element);
    if (!added.has(k)) changed.add(k);
  }
  for (const id of gone) if (!planThing(id) && !take(id, 'remove')) removed.push(id);
  const marks: PlanMark[] = [];
  let n = 0;
  const step = (): { stepId: string; ordinal: number } => ({ stepId: `ai:${idea.id}:${n}`, ordinal: n++ });
  for (const k of added) marks.push({ ...step(), kind: 'touch', keys: [k], word: PREVIEW_WORDS.add });
  for (const k of changed) marks.push({ ...step(), kind: 'touch', keys: [k], word: PREVIEW_WORDS.change });
  const whole = new Set(added);
  for (const id of removed) {
    const cable = id.startsWith('cable:');
    if (!cable) whole.add(key(id));
    marks.push({ ...step(), kind: cable ? 'cut-cable' : 'touch', keys: [cable ? id : key(id)], word: PREVIEW_WORDS.remove, removed: true });
  }
  const inside = insides.finish(whole, step);
  marks.push(...inside.marks);
  const read: Plan[] = [];
  for (const id of plans) {
    try {
      read.push(readPlan(drawn, id));
    } catch {
      // Not a live plan on the copy: nothing to show of it.
    }
  }
  for (const plan of read) for (const m of planMarks(drawn, canon, plan)) marks.push({ ...step(), ...m });
  return { doc: drawn, marks, canon, parts: inside.parts, plans: read };
}

/** The plan `id` is, or belongs to (a step, or the edge seating a step in its plan); null for anything else. */
function planHolding(doc: Document, id: string): string | null {
  const edge = findEdge(doc, id);
  if (edge != null) return edge.id.startsWith('has-step:') ? edge.from : null;
  let kind: string;
  try {
    kind = parseNodeId(id).kind;
  } catch {
    return null;
  }
  if (kind === 'MaintenancePlan') return id;
  if (kind === 'PlanStep') return edgesIn(doc, id, 'HasStep')[0]?.from ?? id;
  return null;
}

/** "STEP 2", "STEPS 1–7", "STEPS 1, 3, 5": the steps of a plan that work on one thing, counted from 1. */
export function stepsWord(steps: readonly number[]): string {
  const n = [...new Set(steps)].sort((a, b) => a - b);
  if (n.length === 0) return '';
  if (n.length === 1) return `STEP ${n[0]}`;
  const run = n.every((x, i) => i === 0 || x === n[i - 1]! + 1);
  return `STEPS ${run ? `${n[0]}–${n[n.length - 1]}` : n.join(', ')}`;
}

const HOST_EDGE = '[^a-z0-9_-]';

/** The tags a plan puts on the canvas: one on each device its steps name in their targets, with the steps; when no
 * step names anything, one on each device whose hostname the plan's title or steps spell out. */
function planMarks(doc: Document, canon: Canon, plan: Plan): Omit<PlanMark, 'stepId' | 'ordinal'>[] {
  const byDevice = new Map<string, number[]>();
  plan.steps.forEach((s, i) => {
    for (const t of s.targets) {
      if (findNode(doc, t) == null) continue;
      const key = canon(t);
      byDevice.set(key, [...(byDevice.get(key) ?? []), i + 1]);
    }
  });
  if (byDevice.size > 0)
    return [...byDevice].map(([key, steps]) => ({ kind: 'touch' as const, keys: [key], word: `${PREVIEW_WORDS.plans} · ${stepsWord(steps)}` }));
  const words = [plan.title, ...plan.steps.map((s) => s.change)].join('\n').toLowerCase();
  const named: string[] = [];
  for (const n of doc.nodes) {
    if (n.absentSince !== undefined || !n.id.startsWith('device:')) continue;
    const host = (asString(fieldValue(n.fields, 'Device.hostname')) ?? '').trim().toLowerCase();
    if (host.length < 3) continue;
    const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|${HOST_EDGE})${escaped}($|${HOST_EDGE})`).test(words)) named.push(n.id);
  }
  return named.map((id) => ({ kind: 'touch' as const, keys: [id], word: PREVIEW_WORDS.plans }));
}

export function createAiPreviewStore(): AiPreviewStore {
  let state = NONE;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    show(idea, drawn, canon) {
      if (idea == null || idea.preview == null) {
        state = NONE;
      } else {
        const { marks, parts } = drawn ?? previewOutlines(idea.id, idea.preview, canon ?? IDENTITY);
        const focus = marks.length > 0 ? new Set(marks.flatMap((m) => m.keys)) : null;
        state = { ideaId: idea.id, marks, focus, doc: drawn?.doc ?? null, canon: drawn?.canon ?? null, parts, plans: drawn?.plans ?? [] };
      }
      listeners.forEach((l) => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const AiPreviewContext = createContext<AiPreviewStore | null>(null);

const NO_SUBSCRIBE = (): (() => void) => () => {};

/** The preview to draw; none outside a provider. */
export function useAiPreview(): AiPreviewState {
  const store = useContext(AiPreviewContext);
  const get = (): AiPreviewState => store?.get() ?? NONE;
  return useSyncExternalStore(store?.subscribe ?? NO_SUBSCRIBE, get, get);
}
