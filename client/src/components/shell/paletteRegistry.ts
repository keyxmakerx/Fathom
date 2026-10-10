// Lets the place that knows what is selected (Racks) offer its own actions to the command palette,
// which is built higher up, without passing handlers through every layer in between.

import { createContext, useContext, useEffect, useRef } from 'react';

import type { PaletteAction } from './palette';

export interface PaletteRegistry {
  /** Offers actions under `id`; the getter is asked each time the palette opens. Returns the way to withdraw them. */
  register: (id: string, get: () => PaletteAction[]) => () => void;
  /** Every registered action, in the order registered. */
  all: () => PaletteAction[];
}

export function createPaletteRegistry(): PaletteRegistry {
  const sources = new Map<string, () => PaletteAction[]>();
  return {
    register(id, get) {
      sources.set(id, get);
      return () => {
        if (sources.get(id) === get) sources.delete(id);
      };
    },
    all: () => [...sources.values()].flatMap((get) => get()),
  };
}

export const PaletteRegistryContext = createContext<PaletteRegistry | null>(null);

/** Offers `get()`'s actions to the palette while this component is mounted. `get` is read fresh each time. */
export function usePaletteActions(id: string, get: () => PaletteAction[]): void {
  const registry = useContext(PaletteRegistryContext);
  const latest = useRef(get);
  latest.current = get;
  useEffect(() => registry?.register(id, () => latest.current()), [registry, id]);
}
