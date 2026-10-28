// An AI idea's proposed change on the canvas before anyone accepts it (owner, 2026-10-27: an AI never changes a
// design itself; its change shows the way a plan does, in the plan colour, and the person accepts it). The ideas
// panel writes the store; the drawing only reads it. Nothing here is in the document.
import { createContext, useContext, useSyncExternalStore } from 'react';

import type { AiIdea, IdeaPreview } from '../../api/ai';
import { applyChange, type Change } from '../../document/change';
import { findEdge, type Document } from '../../document/model';
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
}

/** What the canvas draws for an idea whose change was built: the design with it made, and the marks on it. */
export interface DrawnPreview {
  doc: Document;
  marks: PlanMark[];
  canon: Canon;
}

export interface AiPreviewStore {
  get(): AiPreviewState;
  /** Shows `idea`, drawn on `drawn` when its change was built, else as outlines on what it names. */
  show(idea: AiIdea | null, drawn?: DrawnPreview | null): void;
  subscribe(listener: () => void): () => void;
}

const NONE: AiPreviewState = { ideaId: null, marks: [], focus: null, doc: null, canon: null };

/** A link end the reading named (kind:ULID), rather than a name the change gave something new. */
const isId = (end: string): boolean => /^[a-z-]+:[0-9A-HJKMNP-TV-Z]{26}$/.test(end);

/** The tags on the canvas: what Accept and apply would do to each thing. */
export const PREVIEW_WORDS = { change: 'AI CHANGES', remove: 'AI REMOVES', add: 'AI ADDS' } as const;

/** The marks for a preview: an outline on what it changes, a greyed outline on what it removes (a cable it removes
 * is cut), and a dashed line for a link between two things already there. What it adds is drawn only once the
 * change is built (`drawnPreview`). */
export function previewMarks(ideaId: string, preview: IdeaPreview): PlanMark[] {
  const marks: PlanMark[] = [];
  let n = 0;
  const step = (): { stepId: string; ordinal: number } => ({ stepId: `ai:${ideaId}:${n}`, ordinal: n++ });
  for (const id of preview.changes) marks.push({ ...step(), kind: 'touch', keys: [id], word: PREVIEW_WORDS.change });
  for (const id of preview.removes)
    marks.push({ ...step(), kind: id.startsWith('cable:') ? 'cut-cable' : 'touch', keys: [id], word: PREVIEW_WORDS.remove, removed: true });
  for (const l of preview.links)
    if (isId(l.from) && isId(l.to)) marks.push({ ...step(), kind: 'add-cable', keys: [l.from, l.to], ends: [l.from, l.to], word: PREVIEW_WORDS.add });
  return marks;
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
  const added = new Set<string>();
  const changed = new Set<string>();
  for (const op of change.batch.ops) {
    if (op.type === 'add_node') added.add(key(op.node));
    else if (op.type === 'add_edge') added.add(op.edge);
  }
  for (const op of change.batch.ops) {
    if (op.type !== 'set_field' || gone.has(op.element)) continue;
    const k = key(op.element);
    if (!added.has(k)) changed.add(k);
  }
  const marks: PlanMark[] = [];
  let n = 0;
  const step = (): { stepId: string; ordinal: number } => ({ stepId: `ai:${idea.id}:${n}`, ordinal: n++ });
  for (const k of added) marks.push({ ...step(), kind: 'touch', keys: [k], word: PREVIEW_WORDS.add });
  for (const k of changed) marks.push({ ...step(), kind: 'touch', keys: [k], word: PREVIEW_WORDS.change });
  for (const id of gone) {
    const cable = id.startsWith('cable:');
    marks.push({ ...step(), kind: cable ? 'cut-cable' : 'touch', keys: [cable ? id : key(id)], word: PREVIEW_WORDS.remove, removed: true });
  }
  return { doc: drawn, marks, canon };
}

export function createAiPreviewStore(): AiPreviewStore {
  let state = NONE;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    show(idea, drawn) {
      if (idea == null || idea.preview == null) {
        state = NONE;
      } else {
        const marks = drawn?.marks ?? previewMarks(idea.id, idea.preview);
        const focus = marks.length > 0 ? new Set(marks.flatMap((m) => m.keys)) : null;
        state = { ideaId: idea.id, marks, focus, doc: drawn?.doc ?? null, canon: drawn?.canon ?? null };
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
