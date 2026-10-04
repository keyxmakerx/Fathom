// The Inventory list's state, kept in the address bar's hash (listState.ts). Anything that opens a
// page or another list pushes a history entry, so the browser's Back (and the page's own Back
// button, which is the same thing) returns to where you were. Everything else rewrites the current
// entry, a moment after the last keystroke so typing does not flood history.
//
// An entry we pushed carries `back`: the name of the place it was pushed from ("R12", "Cables").
// That is the Back button's label, and it survives a reload because history.state does.

import { useCallback, useEffect, useRef, useState } from 'react';

import { EMPTY_STATE, carryWhere, formatHash, parseHash, type ListState } from './listState';

/** `from` names the place being left; it is the new entry's Back label. */
export type Go = (patch: Partial<ListState>, mode?: 'replace' | 'push', from?: string) => void;

interface EntryState {
  inv: 'open' | 'list';
  back?: string;
}

const entryOf = (ls: ListState, back: string | undefined): EntryState => (back === undefined ? { inv: ls.open ? 'open' : 'list' } : { inv: ls.open ? 'open' : 'list', back });

const backOf = (st: unknown): string | undefined => {
  const b = (st as { back?: unknown } | null)?.back;
  return typeof b === 'string' ? b : undefined;
};

export function useListState(): {
  ls: ListState;
  go: Go;
  /** One step back in history; without an earlier entry of ours, closes the open page instead. */
  back: () => void;
  /** The label for Back: where it goes. Undefined when there is no earlier entry of ours. */
  backLabel: string | undefined;
  /** Counts Back and Forward moves, so a list can put its scroll and ticks back. */
  moves: number;
} {
  const [ls, setLs] = useState<ListState>(() => (typeof window === 'undefined' ? EMPTY_STATE : (parseHash(window.location.hash) ?? EMPTY_STATE)));
  const [backLabel, setBackLabel] = useState<string | undefined>(() => (typeof window === 'undefined' ? undefined : backOf(window.history.state)));
  const [moves, setMoves] = useState(0);
  const latest = useRef(ls);
  latest.current = ls;
  const backRef = useRef(backLabel);
  const timer = useRef<number | null>(null);
  const pending = useRef<ListState | null>(null);

  const flush = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next) window.history.replaceState(entryOf(next, backRef.current), '', formatHash(next));
  }, []);

  useEffect(() => {
    // The entry we arrived on keeps its Back label, so a reload on a page still says where Back goes.
    window.history.replaceState(entryOf(latest.current, backOf(window.history.state)), '', formatHash(latest.current));
    const onPop = () => {
      const p = parseHash(window.location.hash);
      if (!p) return;
      pending.current = null;
      const landed = carryWhere(p, latest.current);
      backRef.current = backOf(window.history.state);
      setBackLabel(backRef.current);
      latest.current = landed;
      setLs(landed);
      setMoves((n) => n + 1);
      // The entry's own address may name an older Where; write the kept one over it.
      if (formatHash(landed) !== formatHash(p)) window.history.replaceState(entryOf(landed, backRef.current), '', formatHash(landed));
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      flush();
    };
  }, [flush]);

  const go = useCallback<Go>(
    (patch, mode = 'replace', from) => {
      const next = { ...latest.current, ...patch };
      latest.current = next;
      setLs(next);
      if (mode === 'push') {
        flush();
        backRef.current = from ?? '';
        setBackLabel(backRef.current);
        window.history.pushState(entryOf(next, backRef.current), '', formatHash(next));
      } else {
        pending.current = next;
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(flush, 200);
      }
    },
    [flush],
  );

  const back = useCallback(() => {
    flush();
    // An entry we pushed has the place it came from behind it. A pasted link to a page does not.
    if (backRef.current !== undefined) window.history.back();
    else go({ open: '', tab: '' });
  }, [flush, go]);

  return { ls, go, back, backLabel, moves };
}
