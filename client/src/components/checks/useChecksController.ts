// Runs Checks for one open design: standing checks after the document settles, the gesture guard, and the
// panel's own state. The engine and mirror are the ones the page already holds (RacksPlace); this boots nothing.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Document } from '../../document/model';
import type { CheckFinding, ChecksResult } from '../../engine/engine';
import type { Mirror } from '../../engine/mirror';
import { buildBadgeMap, buildCanon, findingKey, involvedKeys, totalCount } from './checksModel';
import { createChecksStore, type ChecksApi } from './checksStore';

/** Quiet time after the last document change before the standing checks run. */
export const CHECKS_DEBOUNCE_MS = 300;
const STORAGE_KEY = 'fathom.checks.panel';

export interface PanelPrefs {
  /** Offset from the docked corner, px. */
  x: number;
  y: number;
  /** null = follow the findings: open when there are any. */
  open: boolean | null;
}

const DEFAULT_PREFS: PanelPrefs = { x: 0, y: 0, open: null };

export function loadPrefs(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): PanelPrefs {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const v = JSON.parse(raw) as Partial<PanelPrefs>;
    return {
      x: typeof v.x === 'number' && Number.isFinite(v.x) ? v.x : 0,
      y: typeof v.y === 'number' && Number.isFinite(v.y) ? v.y : 0,
      open: typeof v.open === 'boolean' ? v.open : null,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: PanelPrefs, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode or a full disk: the panel just forgets where it was.
  }
}

export interface RefusalState {
  finding: CheckFinding;
  x: number;
  y: number;
}

export interface ChecksController {
  api: ChecksApi;
  result: ChecksResult | null;
  /** The engine did not run (it failed to start or threw). */
  unavailable: boolean;
  open: boolean;
  setOpen(open: boolean): void;
  prefs: PanelPrefs;
  setOffset(x: number, y: number): void;
  why: CheckFinding | null;
  openWhy(f: CheckFinding): void;
  closeWhy(): void;
  showKey: string | null;
  toggleShow(f: CheckFinding): void;
  refusal: RefusalState | null;
  dismissRefusal(): void;
}

interface Inputs {
  doc: Document | null;
  /** Starts the engine once (RacksPlace's `ensureMirror`). */
  boot: () => Promise<Mirror>;
  /** The mirror, brought up to `doc` if stale; null before it has booted. */
  mirrorNow: () => Mirror | null;
}

export function useChecksController({ doc, boot, mirrorNow }: Inputs): ChecksController {
  const [store] = useState(createChecksStore);
  const [result, setResult] = useState<ChecksResult | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [prefs, setPrefs] = useState<PanelPrefs>(() => loadPrefs());
  const [why, setWhy] = useState<CheckFinding | null>(null);
  const [showKey, setShowKey] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<RefusalState | null>(null);
  const latest = useRef({ boot, mirrorNow });
  latest.current = { boot, mirrorNow };
  const pointer = useRef({ x: 0, y: 0 });
  const tokenRef = useRef(0);

  // Where the pointer last was: the refusal card opens there.
  useEffect(() => {
    pointer.current = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const track = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('pointermove', track, true);
    window.addEventListener('pointerup', track, true);
    return () => {
      window.removeEventListener('pointermove', track, true);
      window.removeEventListener('pointerup', track, true);
    };
  }, []);

  // Standing checks, once the document has been quiet for a moment.
  useEffect(() => {
    if (doc == null) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      latest.current
        .boot()
        .then(() => {
          const mirror = latest.current.mirrorNow();
          if (cancelled || mirror == null) return;
          const next = mirror.checks();
          const canon = buildCanon(doc);
          store.set({ badges: buildBadgeMap(next.findings, canon), canon });
          setResult(next);
          setUnavailable(false);
          const show = store.get().show;
          if (show != null && !next.findings.some((f) => findingKey(f) === findingKey(show.finding))) {
            store.set({ show: null });
            setShowKey(null);
          }
        })
        .catch(() => {
          if (!cancelled) setUnavailable(true);
        });
    }, CHECKS_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [doc, store]);

  const guardCable = useCallback<ChecksApi['guardCable']>((from, to, medias) => {
    try {
      const mirror = latest.current.mirrorNow();
      if (mirror == null) return false;
      for (const media of medias) {
        const hit = mirror.checkCable({ port: from }, { port: to }, media).find((r) => r.severity === 'refuse');
        if (hit != null) {
          setRefusal({ finding: hit, x: pointer.current.x, y: pointer.current.y });
          return true;
        }
      }
    } catch {
      // The checks never block a drawing: a failure here is a pass.
    }
    setRefusal(null);
    return false;
  }, []);

  const clearShow = useCallback(() => {
    store.set({ show: null });
    setShowKey(null);
  }, [store]);

  const toggleShow = useCallback(
    (f: CheckFinding) => {
      const key = findingKey(f);
      if (store.get().show != null && findingKey(store.get().show!.finding) === key) {
        clearShow();
        return;
      }
      tokenRef.current += 1;
      store.set({ show: { finding: f, keys: involvedKeys(f, store.get().canon), token: tokenRef.current } });
      setShowKey(key);
    },
    [store, clearShow],
  );

  const api = useMemo<ChecksApi>(() => ({ store, guardCable, clearShow }), [store, guardCable, clearShow]);

  const update = useCallback((patch: Partial<PanelPrefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs(next);
      return next;
    });
  }, []);

  const open = prefs.open ?? (result != null && totalCount(result) > 0);

  return {
    api,
    result,
    unavailable,
    open,
    setOpen: (o) => update({ open: o }),
    prefs,
    setOffset: (x, y) => update({ x, y }),
    why,
    openWhy: (f) => {
      setWhy(f);
      if (!open) update({ open: true });
    },
    closeWhy: () => setWhy(null),
    showKey,
    toggleShow,
    refusal,
    dismissRefusal: () => setRefusal(null),
  };
}

