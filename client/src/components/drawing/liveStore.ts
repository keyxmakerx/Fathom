/**
 * The drawing's own external store for anything hover, selection, the lit
 * path or a drag touches — GitHub issue #66. `Drawing.tsx` used to carry
 * every one of these straight into each React Flow node's `data`, so a
 * hover or a zoom tick rebuilt every node object, and React Flow drops a
 * node's measured size whenever its node object changes — a slow machine
 * saw nodes blink or stay blank. React Flow's own advice (their docs on a
 * large flow): keep this in a small store nodes subscribe to with a
 * selector, so a change here re-renders only the node whose OWN answer
 * changed, never the node object array itself.
 *
 * Deliberately not the deep-comparison approach tried before this: nothing
 * here is compared against a whole design, and nothing here is a memo whose
 * key is an object rebuilt every render — every subscriber picks its own
 * primitive (or small, referentially-stable) answer out of `LiveState`, and
 * `useSyncExternalStore`'s own `Object.is` check is what decides whether
 * that subscriber re-renders at all.
 */

import { createContext, useContext, useSyncExternalStore } from 'react';
import type { Selection } from './contract';

export type DropPreview = Record<string, { fromU: number; toU: number; valid: boolean }>;

export interface LiveState {
  selected: Selection | null;
  /** The selected cable, or the hovered one — `Drawing.tsx`'s own
   * `litCableId`. Lights a cable's edge, a rail hexagon's own inlet glyph,
   * a portal tray's outline. */
  litCableId: string | null;
  litTrayKeySet: ReadonlySet<string>;
  /** Non-null while a drag-to-connect is in progress. */
  dragFromPortId: string | null;
  livePortIds: ReadonlySet<string>;
  /** Keyed by rack id — set while a device is being dragged over it. */
  dropPreview: DropPreview;
  /** The rack, if any, mid-shake after a refused drop. */
  shakingRackId: string | null;
  /** s6g #1, UI-SPEC "Config": "Plate stays above, dimmed" — the selected
   * chassis's own id while its config drawer is open, `null` otherwise. */
  dimmedChassisId: string | null;
}

export const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

export const INITIAL_LIVE_STATE: LiveState = {
  selected: null,
  litCableId: null,
  litTrayKeySet: EMPTY_STRING_SET,
  dragFromPortId: null,
  livePortIds: EMPTY_STRING_SET,
  dropPreview: {},
  shakingRackId: null,
  dimmedChassisId: null,
};

export interface LiveStore {
  getState(): LiveState;
  setState(patch: Partial<LiveState>): void;
  subscribe(listener: () => void): () => void;
}

export function createLiveStore(initial: LiveState = INITIAL_LIVE_STATE): LiveStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    setState(patch) {
      state = { ...state, ...patch };
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const LiveStoreContext = createContext<LiveStore | null>(null);
export const LiveStoreProvider = LiveStoreContext.Provider;

/** A node's own selector into the store — re-renders that node, and only
 * that node, when the value its own selector picks out actually changes
 * (`useSyncExternalStore`'s own `Object.is` check on the selector's
 * result). Thrown outside a `LiveStoreProvider` rather than silently
 * reading a default: every node this drawing draws is mounted under
 * `Drawing.tsx`'s own provider, so reaching this without one is a wiring
 * mistake, not a real "no store yet" state. */
export function useLive<T>(selector: (state: LiveState) => T): T {
  const store = useContext(LiveStoreContext);
  if (store == null) throw new Error('useLive: no LiveStoreProvider above this node');
  const getSnapshot = () => selector(store.getState());
  // The third argument is `getServerSnapshot` — this store holds nothing
  // that differs between a server render and the browser (there is no
  // server at all; `renderToStaticMarkup`'s own render-to-string tests are
  // the one caller that needs this), so the same snapshot answers both.
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
