// The drawing's store for hover, selection, the lit path, drag state and the
// camera stop; a node re-renders only when its own selector's answer changes.

import { createContext, useContext, useSyncExternalStore } from 'react';
import type { Selection } from './contract';
import type { CameraStop } from './geometry';

export type DropPreview = Record<string, { fromU: number; toU: number; valid: boolean }>;

export interface LiveState {
  selected: Selection | null;
  /** The selected cable, or else the hovered one: lights its edge, its inlet
   * glyph and its portal tray. */
  litCableId: string | null;
  /** Every cable and tray on `litCableId`'s own physical path — a cable
   * edge reads its own membership here rather than through its `data`. */
  litCableIdSet: ReadonlySet<string>;
  litTrayKeySet: ReadonlySet<string>;
  /** The cable a mouse is over, written straight here by a hover handler —
   * never through `Drawing.tsx`'s state, so a hover alone never re-renders it. */
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
  /** The camera's current stop, so a node re-renders when the stop changes,
   * never on a wheel tick within it. */
  cameraStop: CameraStop;
  /** Port glyphs are drawn only once the camera is close enough to read them. */
  showPortGlyphs: boolean;
  /** Close in, a bundle is drawn as its separate cables. */
  splitBundles: boolean;
  /** The cables the colour key is lighting; every other cable dims. `null` lights nothing in particular. */
  keyCableIds: ReadonlySet<string> | null;
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
  showPortGlyphs: false,
  splitBundles: false,
  keyCableIds: null,
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

/** The store itself, for a handle that writes to it (a shelf's resize grip lights the rail). */
export function useLiveStore(): LiveStore {
  const store = useContext(LiveStoreContext);
  if (store == null) throw new Error('useLiveStore: no LiveStoreProvider above this node');
  return store;
}

/** Re-renders the calling node when its selector's answer changes by
 * `Object.is`; throws outside a `LiveStoreProvider`, which is a wiring mistake. */
export function useLive<T>(selector: (state: LiveState) => T): T {
  const store = useContext(LiveStoreContext);
  if (store == null) throw new Error('useLive: no LiveStoreProvider above this node');
  const getSnapshot = () => selector(store.getState());
  // The same snapshot serves `renderToStaticMarkup` in tests, which needs a
  // server snapshot.
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
