// Per-person canvas settings, kept in this browser (like the theme): what the mouse wheel does.
// Nothing here reaches the server, so no schema or migration is involved.

import { useCallback, useState } from 'react';

export type WheelMode = 'scroll' | 'zoom';

const STORAGE_KEY = 'fathom-canvas-wheel';

/** The stored choice, or null when the person has not chosen (each view then keeps its own default). */
export function getStoredWheel(): WheelMode | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'scroll' || value === 'zoom' ? value : null;
  } catch {
    return null;
  }
}

function storeWheel(mode: WheelMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Private mode or blocked storage: the choice lasts until the page closes.
  }
}

/** The wheel mode and its setter; `fallback` is the view's own default until a choice is made. */
export function useWheelMode(fallback: WheelMode): [WheelMode, (mode: WheelMode) => void] {
  const [mode, setMode] = useState<WheelMode>(() => getStoredWheel() ?? fallback);
  const set = useCallback((next: WheelMode) => {
    storeWheel(next);
    setMode(next);
  }, []);
  return [mode, set];
}
