// What the canvas reads from Checks: per-device and per-cable badge counts and the Show fade. An external
// store, so a node re-renders only when its own count changes, never when the panel moves.
import { createContext, useContext, useSyncExternalStore } from 'react';

import type { CheckFinding } from '../../engine/engine';
import type { Canon } from './checksModel';

export interface ShowState {
  finding: CheckFinding;
  /** Canonical ids the finding touches. */
  keys: ReadonlySet<string>;
  /** Bumps on every Show click, so the camera moves again even for the same finding. */
  token: number;
}

export interface ChecksState {
  badges: ReadonlyMap<string, number>;
  canon: Canon;
  show: ShowState | null;
  /** Px the open, docked panel takes on the canvas's right edge; 0 when it is folded or has been moved. */
  panelInset: number;
}

export interface ChecksStore {
  get(): ChecksState;
  set(patch: Partial<ChecksState>): void;
  subscribe(listener: () => void): () => void;
}

export function createChecksStore(): ChecksStore {
  let state: ChecksState = { badges: new Map(), canon: (id) => id, show: null, panelInset: 0 };
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

/** What the drawing is handed. Stable for the life of the page, so it never re-renders the canvas. */
export interface ChecksApi {
  store: ChecksStore;
  /** True when the cable is refused: the card is up and the caller must not draw. A failure of the checks
   * themselves is never a refusal. */
  guardCable(fromPortId: string, toPortId: string, medias: readonly string[]): boolean;
  clearShow(): void;
}

export const ChecksContext = createContext<ChecksApi | null>(null);

/** Null outside a Checks provider (a drawing in a test, say), where nothing here applies. */
export function useChecksApi(): ChecksApi | null {
  return useContext(ChecksContext);
}

/** The badge count for an element (a device, a chassis, a port, a cable), 0 for none or outside a provider. */
export function useCheckBadge(id: string): number {
  const api = useContext(ChecksContext);
  const get = (): number => {
    if (api == null) return 0;
    const s = api.store.get();
    return s.badges.size === 0 ? 0 : (s.badges.get(s.canon(id)) ?? 0);
  };
  return useSyncExternalStore(api?.store.subscribe ?? NO_SUBSCRIBE, get, get);
}

const NO_SUBSCRIBE = (): (() => void) => () => {};

export function useChecksShow(): ShowState | null {
  const api = useContext(ChecksContext);
  const get = (): ShowState | null => api?.store.get().show ?? null;
  return useSyncExternalStore(api?.store.subscribe ?? NO_SUBSCRIBE, get, get);
}
