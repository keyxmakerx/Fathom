// The one checks engine and mirror for an open design (ADR-0052 §1/§4, ADR-0061 §5, ADR-0091 as built). Held in
// DesignPlace, above the Canvas and Inventory places, so every view's Checks, the config drawer, the inside stop,
// Plans, It's down and Trace use the same module, and switching view does not boot it again.
//
// `Engine.init()` fetches and boots the wasm module (`engine.ts`'s own doc), which is not free, so it happens on
// first need and never at sign-in or on opening the design. A second "first need" before the first boot resolves
// joins the same boot rather than start another.
import { useCallback, useMemo, useRef, useState, type MutableRefObject } from 'react';

import type { Document } from '../../document/model';
import { Engine, EngineTrap } from '../../engine/engine';
import { Mirror } from '../../engine/mirror';

export interface DesignEngine {
  /** The mirror; null before it has booted, or after a trap until the next need boots another. */
  mirrorRef: MutableRefObject<Mirror | null>;
  /** The engine itself, for the redaction gate Plans runs its notes through. */
  engineRef: MutableRefObject<Engine | null>;
  /** The `Document` the module currently holds, by reference. `writePlain` and `loadPlain` (`mirror.ts`'s `load`)
   * are not free (measured: seconds on a realistic multi-thousand-line capture), so every caller loads the module
   * only when the document it holds is stale. Reference equality is enough: every `document/commands.ts` and
   * `document/edit.ts` call and `mirror.pasteInto`'s readback return a fresh `Document`. */
  mirrorLoadedDocRef: MutableRefObject<Document | null>;
  /** Bumps once the mirror goes from null to real, or is dropped: a ref change alone schedules no render. */
  version: number;
  /** A trapped module is never reused: drop it, so the next need boots another and loads the design whole. */
  discardTrapped: () => void;
  /** Boots the engine once. */
  ensureMirror: () => Promise<Mirror>;
  /** Syncs `target` into the module, measuring what it cost. */
  loadInto: (mirror: Mirror, target: Document, discard?: () => void) => void;
  /** How long the last sync of the module took, ms; null before there has been a measurable one. */
  loadCostMs: () => number | null;
}

export function useDesignEngine(): DesignEngine {
  const mirrorRef = useRef<Mirror | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const mirrorPromiseRef = useRef<Promise<Mirror> | null>(null);
  const mirrorLoadedDocRef = useRef<Document | null>(null);
  const [version, setVersion] = useState(0);

  const discardTrapped = useCallback(() => {
    mirrorRef.current = null;
    mirrorPromiseRef.current = null;
    mirrorLoadedDocRef.current = null;
    setVersion((n) => n + 1);
  }, []);

  const ensureMirror = useCallback((): Promise<Mirror> => {
    if (mirrorRef.current?.trapped) discardTrapped();
    if (mirrorPromiseRef.current == null) {
      mirrorPromiseRef.current = Engine.init().then((engine) => {
        const mirror = new Mirror(engine);
        engineRef.current = engine;
        mirrorRef.current = mirror;
        setVersion((n) => n + 1);
        return mirror;
      });
    }
    return mirrorPromiseRef.current;
  }, [discardTrapped]);

  // Checks sizes its wait and its guard by the last sync's cost. After the first full load the next sync is a
  // delta, so one full load says little about it and is not counted; a second full load in a row (the module keeps
  // answering "resync needed") is the real cost and is.
  const loadCostRef = useRef<number | null>(null);
  const fullStreakRef = useRef(0);
  const loadInto = useCallback(
    (mirror: Mirror, target: Document, discard: () => void = discardTrapped) => {
      const t0 = performance.now();
      let kind: ReturnType<Mirror['sync']>;
      try {
        kind = mirror.sync(target);
      } catch (e) {
        if (e instanceof EngineTrap) discard();
        throw e;
      }
      const ms = performance.now() - t0;
      fullStreakRef.current = kind === 'full' ? fullStreakRef.current + 1 : 0;
      if (kind === 'delta' || (kind === 'full' && fullStreakRef.current > 1)) loadCostRef.current = ms;
      mirrorLoadedDocRef.current = target;
    },
    [discardTrapped],
  );
  const loadCostMs = useCallback(() => loadCostRef.current, []);

  return useMemo(
    () => ({ mirrorRef, engineRef, mirrorLoadedDocRef, version, discardTrapped, ensureMirror, loadInto, loadCostMs }),
    [version, discardTrapped, ensureMirror, loadInto, loadCostMs],
  );
}

/** The engine for one document: `withMirror` boots and syncs before a use; `mirrorNow` returns what is booted
 * (synced first if stale, unless `load` is false), for Checks' standing run and gesture guard. */
export function useMirrorFor(engine: DesignEngine, doc: Document | null) {
  const { ensureMirror, loadInto, mirrorRef, mirrorLoadedDocRef } = engine;
  const withMirror = useCallback(async (): Promise<Mirror> => {
    const mirror = await ensureMirror();
    if (doc != null && mirrorLoadedDocRef.current !== doc) loadInto(mirror, doc);
    return mirror;
  }, [ensureMirror, doc, loadInto, mirrorLoadedDocRef]);
  const mirrorNow = useCallback(
    (load = true): Mirror | null => {
      const mirror = mirrorRef.current;
      if (mirror == null || doc == null) return null;
      if (load && mirrorLoadedDocRef.current !== doc) loadInto(mirror, doc);
      return mirror;
    },
    [doc, loadInto, mirrorRef, mirrorLoadedDocRef],
  );
  return { withMirror, mirrorNow };
}
