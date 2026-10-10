import { useCallback, useEffect, useRef, useState } from 'react';

import type { Document } from '../../document/model';
import { freshOwnChange, type FreshChange } from './changeToast';
import '../../styles/toast.css';

/** How long the note stays, and how long its leaving takes. */
export const TOAST_MS = 5_000;
const LEAVE_MS = 150;
/** After the pointer leaves, it stays at least this long. */
const MIN_AFTER_HOVER_MS = 1_500;

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface ChangeToastProps {
  doc: Document | null;
  /** The signed-in account. Only this person's own changes show a note. */
  accountId: string | null;
  /** The batch Undo would undo now, and the one Redo would redo. The button shows only for the note's own batch. */
  undoBatchId: string | null;
  redoBatchId: string | null;
  onUndo: () => void;
  onRedo: () => void;
  /** Hold the note back (a past save is on show). */
  suppressed?: boolean;
}

interface Shown extends FreshChange {
  /** A new key per note, so a newer one replays the entrance. */
  key: number;
}

/**
 * The short note at the bottom centre after you change something, with an Undo button. One at a
 * time: a newer one replaces the older. It goes after about five seconds, and waits while the
 * pointer or the keyboard is on it. A teammate's live edit never shows one.
 */
export function ChangeToast({ doc, accountId, undoBatchId, redoBatchId, onUndo, onRedo, suppressed = false }: ChangeToastProps) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [leaving, setLeaving] = useState(false);
  const seenRef = useRef<Document | null>(null);
  const keyRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedRef = useRef(0);
  const remainingRef = useRef(TOAST_MS);
  const heldRef = useRef(false);

  const clearTimers = useCallback(() => {
    if (timerRef.current != null) clearTimeout(timerRef.current);
    if (leaveTimerRef.current != null) clearTimeout(leaveTimerRef.current);
    timerRef.current = null;
    leaveTimerRef.current = null;
  }, []);

  const leave = useCallback(() => {
    if (timerRef.current != null) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (reducedMotion()) {
      setShown(null);
      return;
    }
    setLeaving(true);
    leaveTimerRef.current = setTimeout(() => {
      setShown(null);
      setLeaving(false);
    }, LEAVE_MS);
  }, []);

  const arm = useCallback(
    (ms: number) => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
      startedRef.current = Date.now();
      remainingRef.current = ms;
      timerRef.current = setTimeout(leave, ms);
    },
    [leave],
  );

  // A fresh change of this person's own shows a note; anyone else's, or a first load, does not.
  useEffect(() => {
    const previous = seenRef.current;
    seenRef.current = doc;
    if (doc == null || suppressed) return;
    const fresh = freshOwnChange(previous, doc, accountId);
    if (fresh === null) return;
    clearTimers();
    keyRef.current += 1;
    setLeaving(false);
    setShown({ ...fresh, key: keyRef.current });
    heldRef.current = false;
    arm(TOAST_MS);
  }, [doc, accountId, suppressed, arm, clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  // The note belongs to its own change: once something else is the thing to undo, it goes.
  const action =
    shown == null
      ? null
      : shown.kind === 'undo'
        ? shown.batchId === redoBatchId
          ? ('Redo' as const)
          : null
        : shown.batchId === undoBatchId
          ? ('Undo' as const)
          : null;
  const stale = shown != null && action == null;
  useEffect(() => {
    if (stale) {
      clearTimers();
      setShown(null);
      setLeaving(false);
    }
  }, [stale, clearTimers]);

  const hold = useCallback(() => {
    heldRef.current = true;
    if (timerRef.current == null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
    remainingRef.current = Math.max(MIN_AFTER_HOVER_MS, remainingRef.current - (Date.now() - startedRef.current));
  }, []);

  const release = useCallback(() => {
    heldRef.current = false;
    if (shown != null && !leaving) arm(remainingRef.current);
  }, [shown, leaving, arm]);

  const press = useCallback(() => {
    if (action === 'Undo') onUndo();
    else if (action === 'Redo') onRedo();
  }, [action, onUndo, onRedo]);

  return (
    <div className="change-toast-host" role="status" aria-live="polite" aria-atomic="true">
      {shown != null && !stale ? (
        <div
          key={shown.key}
          className={leaving ? 'change-toast change-toast--leaving' : 'change-toast'}
          onPointerEnter={hold}
          onPointerLeave={release}
          onFocus={hold}
          onBlur={release}
        >
          <span className="change-toast__words">{shown.words}</span>
          {action != null ? (
            <button type="button" className="change-toast__button" onClick={press}>
              {action}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
