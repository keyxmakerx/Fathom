import { useCallback, useEffect, useRef, useState } from 'react';

/** The right-hand side is one slot with four tabs (Equipment, Details, History, Trail); one is open at a time, or none. */
export type RightTab = 'equipment' | 'details' | 'history' | 'trail';

export interface RightTabInput {
  /** The Equipment list exists here (the Racks place). */
  hasEquipment?: boolean;
  /** Equipment was left open by the last visit. */
  initialEquipment?: boolean;
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
  /** ADR-0066 §3: undefined until the design has loaded; then whether it is empty and can be drawn in. The
   * first answer decides whether Equipment opens by itself; later answers never do (a person who closed it
   * is left alone). */
  autoEquipment?: boolean;
  /** The person already closed Equipment once on this design (kept per browser): it does not open by itself again. */
  equipmentClosedOnce?: boolean;
  /** Equipment was closed (by the person, once per visit is enough to tell: the caller remembers it). */
  onEquipmentClosed?: () => void;
  /** A counter: each bump asks for Equipment to open (the "Add equipment" button on the canvas). */
  equipmentRequest?: number;
}

/** Opens Equipment by itself, once, when the design is found empty on open and nothing else is open, and only
 * until the person has closed Equipment once on that design (`closedOnce`). */
export function decideAutoEquipment(already: boolean, auto: boolean | undefined, pick: RightTab | null, closedOnce = false): { decided: boolean; open: boolean } {
  if (already || auto === undefined) return { decided: already, open: false };
  return { decided: true, open: auto && pick === null && !closedOnce };
}

/** Equipment was open and now is not: the person closed it (or went to another tab). */
export function equipmentClosed(before: RightTab | null, after: RightTab | null): boolean {
  return before === 'equipment' && after !== 'equipment';
}

/** What is actually open: the chosen tab, unless there is nothing behind it. */
export function visibleTab(pick: RightTab | null, have: { hasEquipment?: boolean; hasDetails: boolean; historyOpen: boolean; trailOpen: boolean; hasTrail: boolean }): RightTab | null {
  if (pick === 'equipment') return have.hasEquipment === true ? 'equipment' : null;
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
 * Selecting something shows its Details, unless Equipment is open. If History was open, History mode stays on (the canvas
 * keeps showing the past save, and the History tab stays marked) rather than ending silently;
 * the History tab brings the list back.
 */
export function useRightTab(input: RightTabInput) {
  const { hasEquipment = false, hasDetails, historyOpen, trailOpen, hasTrail, selectionKey, onHistory, onTrailOpenChange, onPick } = input;
  const [pick, setPick] = useState<RightTab | null>(() =>
    input.historyOpen ? 'history' : input.trailOpen ? 'trail' : input.initialEquipment === true && hasEquipment ? 'equipment' : input.initialTab,
  );

  const pickNow = useRef(pick);
  pickNow.current = pick;
  const trailRef = useRef(onTrailOpenChange);
  trailRef.current = onTrailOpenChange;
  const historyRef = useRef(onHistory);
  historyRef.current = onHistory;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  // ADR-0066 §3: Equipment opens by itself on a design found empty when it is opened, once only.
  const autoDecided = useRef(false);
  const { autoEquipment } = input;
  const closedOnceRef = useRef(input.equipmentClosedOnce === true);
  const closedRef = useRef(input.onEquipmentClosed);
  closedRef.current = input.onEquipmentClosed;
  useEffect(() => {
    const d = decideAutoEquipment(autoDecided.current, autoEquipment, pickNow.current, closedOnceRef.current);
    autoDecided.current = d.decided;
    if (d.open) setPick('equipment');
  }, [autoEquipment]);
  // The canvas's own "Add equipment" button.
  const lastRequest = useRef(input.equipmentRequest ?? 0);
  const request = input.equipmentRequest ?? 0;
  useEffect(() => {
    if (request === lastRequest.current) return;
    lastRequest.current = request;
    setPick('equipment');
    trailRef.current?.(false);
  }, [request]);

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
    // While Equipment is open, placing one device after another selects each new one; the list
    // stays open so the next can be dragged out. The Details tab is one click away.
    if (pickNow.current === 'equipment') return;
    setPick('details');
    if (trailRef.current != null) trailRef.current(false);
  }, [selectionKey, hasDetails]);

  const lastPick = useRef<RightTab | null>(pick);
  useEffect(() => {
    if (equipmentClosed(lastPick.current, pick)) {
      closedOnceRef.current = true;
      closedRef.current?.();
    }
    lastPick.current = pick;
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

  const shown = visibleTab(pick, { hasEquipment, hasDetails, historyOpen, trailOpen, hasTrail });
  return { shown, choose, fold };
}
