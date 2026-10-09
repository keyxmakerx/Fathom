// What the canvas reads from a running "It's down" session (ADR-0061 troubleshooting): which things are in the chain,
// which the current step asks about, and which the answers point at. An external store, like plansStore: the panel
// writes it, the drawing only reads it.
import { createContext, useContext, useSyncExternalStore } from 'react';

export interface TroubleState {
  /** False when no session runs: the canvas is drawn as it is. */
  active: boolean;
  /** Canonical ids (a device for anything on it, the cable id for a cable) of every step's targets. */
  chain: ReadonlySet<string>;
  /** The current step's, drawn strongest. */
  current: ReadonlySet<string>;
  /** What the answers point at, tagged on the drawing. */
  suspects: ReadonlySet<string>;
  /** Bumps when the camera should fit the chain. */
  token: number;
}

export interface TroubleStore {
  get(): TroubleState;
  set(patch: Partial<TroubleState>): void;
  subscribe(listener: () => void): () => void;
}

const NONE: ReadonlySet<string> = new Set();
export const NO_TROUBLE: TroubleState = { active: false, chain: NONE, current: NONE, suspects: NONE, token: 0 };

export function createTroubleStore(): TroubleStore {
  let state: TroubleState = NO_TROUBLE;
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

export const TroubleContext = createContext<TroubleStore | null>(null);

const NO_SUBSCRIBE = (): (() => void) => () => {};

/** The session's canvas state; `NO_TROUBLE` outside a provider. */
export function useTroubleState(): TroubleState {
  const store = useContext(TroubleContext);
  const get = (): TroubleState => store?.get() ?? NO_TROUBLE;
  return useSyncExternalStore(store?.subscribe ?? NO_SUBSCRIBE, get, get);
}
