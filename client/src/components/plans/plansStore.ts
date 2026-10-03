// What the canvas reads from an open maintenance plan (ADR-0061 round 7): the marks to draw and what to fade.
// An external store, like checksStore, so the canvas re-renders only when the plan view changes. The plan
// panel (plans/*) writes it; the drawing (drawing/*) only reads it.
import { createContext, useContext, useSyncExternalStore } from 'react';

import type { PlanStage } from '../../document/plans';

/** One planned change, as a mark on the drawing. `keys` are canonical ids (a device for anything on it,
 * the cable id for a cable), the ones `checksModel.buildCanon` produces. */
export interface PlanMark {
  stepId: string;
  ordinal: number;
  kind: 'add-cable' | 'cut-cable' | 'touch';
  keys: readonly string[];
  /** add-cable: the two port ids it would join, drawn as a dashed line between their plates. */
  ends?: readonly [string, string];
  /** The tag on the mark: PLANNED, STEP 4, ✓ DONE, ≠ WENT DIFFERENTLY. */
  word: string;
}

export interface PlansState {
  /** Null when no plan is open: the canvas is drawn as it is. Colours follow the stage: indigo, teal, ink. */
  stage: PlanStage | null;
  marks: readonly PlanMark[];
  /** Keys kept at full strength while the rest fades to the phantom 28% (Do's current step, Record's
   * "Show these changes"); null fades nothing. */
  focus: ReadonlySet<string> | null;
  /** Bumps when the camera should move to `focus`. */
  token: number;
}

export interface PlansStore {
  get(): PlansState;
  set(patch: Partial<PlansState>): void;
  subscribe(listener: () => void): () => void;
}

export const NO_PLAN: PlansState = { stage: null, marks: [], focus: null, token: 0 };

export function createPlansStore(): PlansStore {
  let state: PlansState = NO_PLAN;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch };
      listeners.forEach((l) => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const PlansContext = createContext<PlansStore | null>(null);

const NO_SUBSCRIBE = (): (() => void) => () => {};

/** The open plan's canvas state; `NO_PLAN` outside a provider (a drawing in a test, say). */
export function usePlansState(): PlansState {
  const store = useContext(PlansContext);
  const get = (): PlansState => store?.get() ?? NO_PLAN;
  return useSyncExternalStore(store?.subscribe ?? NO_SUBSCRIBE, get, get);
}
