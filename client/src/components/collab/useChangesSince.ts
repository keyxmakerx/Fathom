import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';

import type { Document } from '../../document/model';
import {
  changesSentence,
  collectChangesSince,
  loadNames,
  loadSeen,
  saveSeen,
  type ChangedThing,
  type ChangesSince,
} from './changesSince';

export interface ChangesShown {
  sentence: string;
  things: ChangedThing[];
  glowed: MutableRefObject<boolean>;
  dismiss(): void;
}

/**
 * What other people changed since this person last saw the design, found once when it opens. The mark of
 * what was seen moves to the newest batch when they leave, hide the tab, or dismiss the bar; the first
 * time a person opens a design it is only set, and nothing shows.
 */
export function useChangesSince(
  doc: Document | null,
  accountId: string | null,
  designId: string,
  people: ReadonlyArray<{ account: string; name: string }>,
): ChangesShown | null {
  const [found, setFound] = useState<ChangesSince | null>(null);
  const decided = useRef(false);
  const glowed = useRef(false);
  const latest = useRef<Document | null>(null);
  latest.current = doc;

  useEffect(() => {
    if (doc === null || decided.current) return;
    decided.current = true;
    const seen = loadSeen(accountId, designId);
    if (seen === null) saveSeen(accountId, designId, doc, Date.now());
    else setFound(collectChangesSince(doc, accountId, seen));
  }, [doc, accountId, designId]);

  // Leaving, or hiding the tab, is seeing it up to here.
  useEffect(() => {
    const seenNow = () => {
      if (latest.current !== null && decided.current) saveSeen(accountId, designId, latest.current, Date.now());
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden') seenNow();
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', seenNow);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', seenNow);
      seenNow();
    };
  }, [accountId, designId]);

  const dismiss = useCallback(() => {
    if (latest.current !== null) saveSeen(accountId, designId, latest.current, Date.now());
    setFound(null);
  }, [accountId, designId]);

  return useMemo(() => {
    if (found === null) return null;
    const names = loadNames(accountId, designId);
    for (const p of people) if (p.name !== '') names.set(p.account, p.name);
    return { sentence: changesSentence(found, (account) => names.get(account) ?? null, Date.now()), things: found.things, glowed, dismiss };
  }, [found, people, accountId, designId, dismiss]);
}
