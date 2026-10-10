// What the canvas reads from an open suggestions card: the ticked cables, drawn as dashed lines until accepted.
// The card writes it; the drawing only reads it. Nothing here is in the document (ADR-0046: suggestions are
// never facts).
import { createContext, useContext, useSyncExternalStore } from 'react';

export interface SuggestedLine {
  key: string;
  ends: readonly [string, string];
}

export interface SuggestStore {
  get(): readonly SuggestedLine[];
  set(lines: readonly SuggestedLine[]): void;
  subscribe(listener: () => void): () => void;
}

const NONE: readonly SuggestedLine[] = [];

export function createSuggestStore(): SuggestStore {
  let lines = NONE;
  const listeners = new Set<() => void>();
  return {
    get: () => lines,
    set(next) {
      lines = next.length === 0 ? NONE : next;
      listeners.forEach((l) => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const SuggestContext = createContext<SuggestStore | null>(null);

const NO_SUBSCRIBE = (): (() => void) => () => {};

/** The lines to draw; none outside a provider. */
export function useSuggestedLines(): readonly SuggestedLine[] {
  const store = useContext(SuggestContext);
  const get = (): readonly SuggestedLine[] => store?.get() ?? NONE;
  return useSyncExternalStore(store?.subscribe ?? NO_SUBSCRIBE, get, get);
}
