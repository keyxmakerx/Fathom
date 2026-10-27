// An AI idea's proposed change on the canvas before anyone accepts it (owner, 2026-10-27: an AI never changes a
// design itself; its change shows the way a plan does, in the plan colour, and the person accepts it). The ideas
// panel writes the store; the drawing only reads it. Nothing here is in the document.
import { createContext, useContext, useSyncExternalStore } from 'react';

import type { AiIdea, IdeaPreview } from '../../api/ai';
import type { PlanMark } from '../plans/plansStore';

export interface AiPreviewState {
  /** The idea being shown, or null when the canvas is drawn as it is. */
  ideaId: string | null;
  marks: readonly PlanMark[];
  /** What the marks touch, kept at full strength while the rest fades. */
  focus: ReadonlySet<string> | null;
}

export interface AiPreviewStore {
  get(): AiPreviewState;
  show(idea: AiIdea | null): void;
  subscribe(listener: () => void): () => void;
}

const NONE: AiPreviewState = { ideaId: null, marks: [], focus: null };

/** A link end the reading named (kind:ULID), rather than a name the change gave something new. */
const isId = (end: string): boolean => /^[a-z-]+:[0-9A-HJKMNP-TV-Z]{26}$/.test(end);

/** The tags on the canvas: what Accept and apply would do to each thing. */
export const PREVIEW_WORDS = { change: 'AI CHANGES', remove: 'AI REMOVES', add: 'AI ADDS' } as const;

/** The marks for a preview: an outline on what it changes, a greyed outline on what it removes (a cable it removes
 * is cut), and a dashed line for a link between two things already there. A node it adds is not drawn: it is
 * named in the panel instead. */
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

export function createAiPreviewStore(): AiPreviewStore {
  let state = NONE;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    show(idea) {
      if (idea == null || idea.preview == null) {
        state = NONE;
      } else {
        const marks = previewMarks(idea.id, idea.preview);
        state = { ideaId: idea.id, marks, focus: marks.length > 0 ? new Set(marks.flatMap((m) => m.keys)) : null };
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
