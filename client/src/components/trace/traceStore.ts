// What the canvas reads from a trace: the path's keys and hop numbers. An external store, so a node re-renders
// only when the trace changes, never while the panel's own text box does.
import { createContext, useContext, useSyncExternalStore } from 'react';

import type { TraceResult } from '../../engine/engine';

export interface TraceState {
  result: TraceResult | null;
}

export interface TraceStore {
  get(): TraceState;
  set(next: TraceState): void;
  subscribe(listener: () => void): () => void;
}

export function createTraceStore(): TraceStore {
  let state: TraceState = { result: null };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      state = next;
      listeners.forEach((l) => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const TraceContext = createContext<TraceStore | null>(null);

const NO_SUBSCRIBE = (): (() => void) => () => {};

/** The active trace, or null outside a provider or when none is open. */
export function useTraceResult(): TraceResult | null {
  const store = useContext(TraceContext);
  const get = (): TraceResult | null => store?.get().result ?? null;
  return useSyncExternalStore(store?.subscribe ?? NO_SUBSCRIBE, get, get);
}
