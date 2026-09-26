/**
 * The drawing's own external store for anything hover, selection, the lit
 * path, drag or zoom-band state touches. A node reads its own answer via
 * `useLive`'s selector, so a change here re-renders only the node whose own
 * answer changed, never every node's object at once.
 */

import { createContext, useContext, useSyncExternalStore } from 'react';
import type { Selection } from './contract';
import type { CameraStop } from './geometry';

export type DropPreview = Record<string, { fromU: number; toU: number; valid: boolean }>;

export interface LiveState {
  selected: Selection | null;
  /** The selected cable, or the hovered one — `Drawing.tsx`'s own
   * `litCableId`. Lights a cable's edge, a rail hexagon's own inlet glyph,
   * a portal tray's outline. */
  litCableId: string | null;
  /** Every cable and tray on `litCableId`'s own physical path — a cable
   * edge reads its own membership here instead of through its `data`, so a
   * hover never rebuilds the edges array. */
  litCableIdSet: ReadonlySet<string>;
  litTrayKeySet: ReadonlySet<string>;
  /** The cable a mouse is currently over — written straight here by
   * `CableEdge`/`RackNode`'s own hover handlers, never through
   * `Drawing.tsx`'s state, so a hover alone never re-renders it. */
  hoveredCableId: string | null;
  /** Non-null while a drag-to-connect is in progress. */
  dragFromPortId: string | null;
  livePortIds: ReadonlySet<string>;
  /** Keyed by rack id — set while a device is being dragged over it. */
  dropPreview: DropPreview;
  /** The rack, if any, mid-shake after a refused drop. */
  shakingRackId: string | null;
  /** UI-SPEC "Config": "Plate stays above, dimmed" — the selected chassis's
   * own id while its config drawer is open, `null` otherwise. */
  dimmedChassisId: string | null;
  /** The camera's current stop — a shelf plate reads this instead of the
   * viewport itself, so a wheel tick only re-renders a shelf when the stop
   * it is in actually changes, not on every tick. */
  cameraStop: CameraStop;
}

export const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

export const INITIAL_LIVE_STATE: LiveState = {
  selected: null,
  litCableId: null,
  litCableIdSet: EMPTY_STRING_SET,
  litTrayKeySet: EMPTY_STRING_SET,
  hoveredCableId: null,
  dragFromPortId: null,
  livePortIds: EMPTY_STRING_SET,
  dropPreview: {},
  shakingRackId: null,
  dimmedChassisId: null,
  cameraStop: 'rack',
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
