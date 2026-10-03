// The Inventory list's state, kept in the address bar's hash (listState.ts). Opening a row pushes a
// history entry, so the browser's Back (or the page's own Back) returns to the same list; everything
// else rewrites the current entry, a moment after the last keystroke so typing does not flood history.

import { useCallback, useEffect, useRef, useState } from 'react';

import { EMPTY_STATE, formatHash, parseHash, type ListState } from './listState';

export type Go = (patch: Partial<ListState>, mode?: 'replace' | 'push') => void;

export function useListState(): { ls: ListState; go: Go; back: () => void } {
  const [ls, setLs] = useState<ListState>(() => (typeof window === 'undefined' ? EMPTY_STATE : (parseHash(window.location.hash) ?? EMPTY_STATE)));
  const latest = useRef(ls);
  latest.current = ls;
  const timer = useRef<number | null>(null);
  const pending = useRef<ListState | null>(null);
  const cameFromList = useRef(false);

  const flush = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next) window.history.replaceState({ inv: next.open ? 'open' : 'list' }, '', formatHash(next));
  }, []);

  useEffect(() => {
    // The entry we arrived on is the list (or the open page a pasted link named).
    window.history.replaceState({ inv: latest.current.open ? 'open' : 'list' }, '', formatHash(latest.current));
    const onPop = () => {
      const p = parseHash(window.location.hash);
      if (!p) return;
      pending.current = null;
      if (!p.open) cameFromList.current = false;
      latest.current = p;
      setLs(p);
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      flush();
    };
  }, [flush]);

  const go = useCallback<Go>(
    (patch, mode = 'replace') => {
      const next = { ...latest.current, ...patch };
      latest.current = next;
      setLs(next);
      if (mode === 'push') {
        flush();
        window.history.pushState({ inv: next.open ? 'open' : 'list' }, '', formatHash(next));
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
    const st = window.history.state as { inv?: string } | null;
    // An entry we pushed has the list behind it; a pasted link to a page does not.
    if (st?.inv === 'open' && window.history.length > 1 && cameFromList.current) window.history.back();
    else go({ open: '', tab: '' });
  }, [flush, go]);

  // `go` with push marks that the entry behind the open page is the list.
  const goTracked = useCallback<Go>(
    (patch, mode = 'replace') => {
      if (mode === 'push' && patch.open) cameFromList.current = true;
      else if (patch.open === '') cameFromList.current = false;
      go(patch, mode);
    },
    [go],
  );

  return { ls, go: goTracked, back };
}
