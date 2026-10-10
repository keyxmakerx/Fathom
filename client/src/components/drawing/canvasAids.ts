// Per-person choices for the small aids on the canvas: the mini-map and the cable colour key.
// Kept in this browser (like the theme and the Show layers) and never sent to the server, so no
// document field is involved.

import { useCallback, useState } from 'react';

export interface AidPrefs {
  /** The mini-map may show on big drawings. */
  minimap: boolean;
  /** `null` means "automatic": shown once the design uses two or more cable colours. */
  colourKey: boolean | null;
}

export const DEFAULT_AIDS: AidPrefs = { minimap: true, colourKey: null };

export type AidId = 'minimap' | 'colourKey';

const keyFor = (accountId: string | null): string => `fathom.aids.${accountId ?? 'anon'}`;

/** Anything stored that is not a clear yes or no falls back to the default. */
export function parseAids(raw: unknown): AidPrefs {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_AIDS;
  const r = raw as Record<string, unknown>;
  return {
    minimap: typeof r.minimap === 'boolean' ? r.minimap : DEFAULT_AIDS.minimap,
    colourKey: typeof r.colourKey === 'boolean' ? r.colourKey : null,
  };
}

export function loadAids(accountId: string | null): AidPrefs {
  try {
    const raw = localStorage.getItem(keyFor(accountId));
    if (raw != null) return parseAids(JSON.parse(raw));
  } catch {
    // storage unavailable or damaged: the defaults
  }
  return DEFAULT_AIDS;
}

export function saveAids(accountId: string | null, prefs: AidPrefs): void {
  try {
    localStorage.setItem(keyFor(accountId), JSON.stringify(prefs));
  } catch {
    // best effort only
  }
}

/** Whether the colour key shows: the person's choice, else automatic (two or more colours in use). */
export function colourKeyShown(pref: boolean | null, colourCount: number): boolean {
  return pref ?? colourCount >= 2;
}

/** The aids' state for one person, remembered across visits. `toggle` takes the key's current shown state so a
 * first click on an automatic key turns it off when it is showing, and on when it is not. */
export function useCanvasAids(accountId: string | null) {
  const [prefs, setPrefs] = useState<AidPrefs>(() => loadAids(accountId));
  const [forAccount, setForAccount] = useState(accountId);
  if (forAccount !== accountId) {
    setForAccount(accountId);
    setPrefs(loadAids(accountId));
  }
  const toggle = useCallback(
    (id: AidId, keyShownNow: boolean) => {
      const next: AidPrefs = id === 'minimap' ? { ...prefs, minimap: !prefs.minimap } : { ...prefs, colourKey: !keyShownNow };
      setPrefs(next);
      saveAids(accountId, next);
    },
    [accountId, prefs],
  );
  return { prefs, toggle };
}
