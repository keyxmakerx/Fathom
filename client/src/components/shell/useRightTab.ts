import { useCallback, useEffect, useRef, useState } from 'react';

/** The right-hand side is one slot with three tabs; one is open at a time, or none. */
export type RightTab = 'details' | 'history' | 'trail';

export interface RightTabInput {
  hasDetails: boolean;
  /** History mode is on (the saves list is the open panel's content). */
  historyOpen: boolean;
  trailOpen: boolean;
  hasTrail: boolean;
  /** A key for what is selected; a new one shows its details. */
  selectionKey: string | null;
  /** The tab the last visit ended on, and the selection it was restored with. */
  initialTab: 'details' | 'trail' | null;
  restoredKey: string | null;
  onHistory?: () => void;
  onTrailOpenChange?: (open: boolean) => void;
  onPick?: (pick: RightTab | null) => void;
}

/** What is actually open: the chosen tab, unless there is nothing behind it. */
export function visibleTab(pick: RightTab | null, have: { hasDetails: boolean; historyOpen: boolean; trailOpen: boolean; hasTrail: boolean }): RightTab | null {
  if (pick === 'details') return have.hasDetails ? 'details' : null;
  if (pick === 'history') return have.historyOpen ? 'history' : null;
  if (pick === 'trail') return have.hasTrail && have.trailOpen ? 'trail' : null;
  return null;
}

/** What to remember of a pick for the next visit: History is a mode, not a place to return to. */
export function rememberedTab(pick: RightTab | null): 'details' | 'trail' | null {
  return pick === 'details' || pick === 'trail' ? pick : null;
}

/**
 * Which right-hand tab is open, and how the three stay in step with the two things the design
 * place owns (History mode and the Trail's open flag).
 *
 * Selecting something shows its Details. If History was open, History mode stays on (the canvas
 * keeps showing the past save, and the History tab stays marked) rather than ending silently;
 * the History tab brings the list back.
 */
export function useRightTab(input: RightTabInput) {
  const { hasDetails, historyOpen, trailOpen, hasTrail, selectionKey, onHistory, onTrailOpenChange, onPick } = input;
  const [pick, setPick] = useState<RightTab | null>(() => (input.historyOpen ? 'history' : input.trailOpen ? 'trail' : input.initialTab));

  const trailRef = useRef(onTrailOpenChange);
  trailRef.current = onTrailOpenChange;
  const historyRef = useRef(onHistory);
  historyRef.current = onHistory;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  // The design place opened or closed these (a refused undo opens the Trail; the bar's History button).
  useEffect(() => {
    if (trailOpen) setPick('trail');
    else setPick((p) => (p === 'trail' ? null : p));
  }, [trailOpen]);
  useEffect(() => {
    if (historyOpen) setPick('history');
    else setPick((p) => (p === 'history' ? null : p));
  }, [historyOpen]);

  // A new thing selected: show its details. The selection a visit ended on is not "new".
  const seen = useRef<string | null>(input.restoredKey);
  const restorePending = useRef(input.restoredKey != null);
  useEffect(() => {
    if (selectionKey == null) {
      if (!restorePending.current) seen.current = null;
      return;
    }
    if (selectionKey === seen.current) {
      restorePending.current = false;
      return;
    }
    if (!hasDetails) return;
    seen.current = selectionKey;
    restorePending.current = false;
    setPick('details');
    if (trailRef.current != null) trailRef.current(false);
  }, [selectionKey, hasDetails]);

  useEffect(() => {
    pickRef.current?.(pick);
  }, [pick]);

  const choose = useCallback(
    (tab: RightTab) => {
      setPick(tab);
      if (tab === 'trail') trailRef.current?.(true);
      else trailRef.current?.(false);
      if (tab === 'history' && !historyOpen) historyRef.current?.();
    },
    [historyOpen],
  );

  /** Fold whatever is open. Folding History leaves History mode, like the bar's History button. */
  const fold = useCallback(
    (tab: RightTab) => {
      if (tab === 'history') {
        historyRef.current?.();
        return;
      }
      if (tab === 'trail') {
        trailRef.current?.(false);
        return;
      }
      setPick(null);
    },
    [],
  );

  const shown = visibleTab(pick, { hasDetails, historyOpen, trailOpen, hasTrail });
  return { shown, choose, fold };
}
