import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type CameraHub } from '../drawing/camera';
import { cameraStopAt } from '../drawing/geometry';
import type { Look } from '../drawing/look';
import type { PaletteAction } from '../shell/palette';
import { usePaletteActions } from '../shell/paletteRegistry';
import { isTypingTarget, matches, shortcutText } from '../shell/shortcuts';
import {
  EMPTY_TRAIL,
  addStep,
  back as stepBack,
  canGoBack,
  canGoForward,
  forward as stepForward,
  jumpTo as stepJumpTo,
  stepLabel,
  visit,
  withCamera,
  type Camera,
  type Move,
  type Spot,
  type Step,
  type Trail,
} from './jumpBack';

/** The design settles (the first fit, a resumed camera) before the first step is made. */
const SETTLE_MS = 900;
/** How long the camera is given to glide to a restored step before stops on the way are ignored no more. */
const RESTORE_MS = 650;

export interface JumpBackInput {
  /** False until the design is open. */
  enabled: boolean;
  look: Look;
  selection: { kind: string; id: string } | null;
  jotId: string | null;
  /** The bar's zoom percentage, which decides the camera stop. */
  zoomPct: number;
  /** The words for what is selected, or for the design when nothing is. */
  nameOf: (selection: { kind: string; id: string } | null) => string;
  /** Whether a step's thing is still in the design; a step whose device was deleted is skipped. */
  exists: (spot: Spot) => boolean;
  hub: CameraHub;
  /** Puts the canvas back at a step: its look, its selection, its open device. The camera is moved by the caller too. */
  go: (spot: Spot, camera: Camera | null) => void;
}

/**
 * "Jump back": a per-tab history of where you have been in this design. It watches the look, what is
 * selected, which device is open and the camera's stop, and makes a step each time one of them changes
 * (a quick run of zoom stops is one step; plain panning and scrolling make none). Going back or forward
 * hands the step to `go`, which restores it, and glides the camera to where it was left. Kept in memory
 * only, so it starts empty in a new tab and is gone when the tab closes.
 */
export function useJumpBack(input: JumpBackInput) {
  const { enabled, look, selection, jotId, zoomPct, nameOf, hub } = input;
  const [trail, setTrail] = useState<Trail>(EMPTY_TRAIL);
  const trailRef = useRef(trail);
  const commit = useCallback((next: Trail) => {
    if (next === trailRef.current) return;
    trailRef.current = next;
    setTrail(next);
  }, []);

  const stop = cameraStopAt(zoomPct);
  const selKind = selection?.kind ?? null;
  const selId = selection?.id ?? null;
  const spot = useMemo<Spot>(() => ({ look, selection: selKind != null && selId != null ? { kind: selKind, id: selId } : null, jotId, stop }), [look, selKind, selId, jotId, stop]);
  const name = nameOf(spot.selection);
  const label = stepLabel({ name, look, jot: jotId != null, stop });

  // Armed a moment after the design opens, once its first fit has moved the camera.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    const t = setTimeout(() => setArmed(true), SETTLE_MS);
    return () => clearTimeout(t);
  }, [enabled]);

  const restoringUntil = useRef(0);
  const latest = useRef({ spot, label, input });
  latest.current = { spot, label, input };
  const cameraNow = useCallback((): Camera | null => {
    const vp = hub.control?.get();
    return vp != null ? { x: vp.x, y: vp.y, zoom: vp.zoom } : null;
  }, [hub]);

  useEffect(() => {
    if (!armed) return;
    commit(visit(trailRef.current, spot, label, cameraNow(), Date.now(), { quiet: Date.now() < restoringUntil.current }));
  }, [armed, spot, label, commit, cameraNow]);

  // The camera a step was left at: the latest place the camera came to rest while it was current.
  useEffect(() => {
    const onSettled = (vp: { x: number; y: number; zoom: number }) => commit(withCamera(trailRef.current, { x: vp.x, y: vp.y, zoom: vp.zoom }));
    hub.onSettled = onSettled;
    return () => {
      if (hub.onSettled === onSettled) hub.onSettled = null;
    };
  }, [hub, commit]);

  const apply = useCallback(
    (move: Move | null): boolean => {
      if (move == null) return false;
      commit(move.trail);
      restoringUntil.current = Date.now() + RESTORE_MS;
      latest.current.input.go(move.step.spot, move.step.camera);
      // Once the camera has arrived, take whatever level it ended at as this step's own.
      setTimeout(() => {
        const { spot: now, label: words } = latest.current;
        commit(visit(trailRef.current, now, words, null, Date.now(), { quiet: true }));
      }, RESTORE_MS);
      return true;
    },
    [commit],
  );
  const stillThere = useCallback((step: Step) => latest.current.input.exists(step.spot), []);
  const goBack = useCallback(() => apply(stepBack(trailRef.current, stillThere)), [apply, stillThere]);
  const goForward = useCallback(() => apply(stepForward(trailRef.current, stillThere)), [apply, stillThere]);
  const goTo = useCallback((index: number) => apply(stepJumpTo(trailRef.current, index)), [apply]);

  /** Opening a saved view is a step of its own, named for the view. Call before moving the camera. */
  const markView = useCallback(
    (viewName: string) => {
      if (!latest.current.input.enabled || trailRef.current.index < 0) return;
      commit(addStep(trailRef.current, latest.current.spot, viewName.trim().toUpperCase(), cameraNow(), Date.now()));
    },
    [commit, cameraNow],
  );

  const canBack = canGoBack(trail);
  const canForward = canGoForward(trail);
  const backLabel = canBack ? trail.steps[trail.index - 1]!.label : null;

  // Alt+Left and Alt+Right, and the mouse's Back and Forward buttons while the pointer is over the canvas. Anywhere else
  // (and whenever there is nowhere to go) they are left to the browser, so the app's other pages keep their own history.
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      if (matches(e, 'go-back')) {
        if (canGoBack(trailRef.current)) {
          e.preventDefault();
          goBack();
        }
      } else if (matches(e, 'go-forward') && canGoForward(trailRef.current)) {
        e.preventDefault();
        goForward();
      }
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      const over = e.target instanceof Element && e.target.closest('.shell__drawing') != null;
      const can = e.button === 3 ? canGoBack(trailRef.current) : canGoForward(trailRef.current);
      if (!over || !can) return;
      e.preventDefault();
      if (e.type === 'mouseup') (e.button === 3 ? goBack : goForward)();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onMouse);
    window.addEventListener('mouseup', onMouse);
    window.addEventListener('auxclick', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouse);
      window.removeEventListener('mouseup', onMouse);
      window.removeEventListener('auxclick', onMouse);
    };
  }, [enabled, goBack, goForward]);

  usePaletteActions('racks-history', (): PaletteAction[] => [
    {
      id: 'go-back',
      label: 'Go back',
      hint: shortcutText('go-back'),
      keywords: ['previous', 'return', 'undo move', 'where i was'],
      disabled: canGoBack(trailRef.current) ? undefined : 'Nowhere earlier in this visit',
      run: () => void goBack(),
    },
    {
      id: 'go-forward',
      label: 'Go forward',
      hint: shortcutText('go-forward'),
      keywords: ['next'],
      disabled: canGoForward(trailRef.current) ? undefined : 'Nowhere further on',
      run: () => void goForward(),
    },
  ]);

  return { trail, canBack, canForward, backLabel, goBack, goForward, goTo, markView };
}
