// The History panel's data: the saves, the server's check, one-line summaries computed in the
// browser, and the version being looked at. Version bodies are fetched on demand and only the
// newest few are kept. The saves themselves come a page at a time, newest first: a design may
// have millions (r53).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fetchHistory, fetchVerify, verifyWords, type HistoryEntry } from '../../api/history';
import { openDesign } from '../../api/payload';
import { describeSave, outlineIds, type SaveChange } from '../../document/historyDiff';
import type { Document } from '../../document/model';
import { readPlain } from '../../document/plain';

const PAGE = 15;
/** Chain entries asked of the server at a time: several pages of the list. */
export const FETCH = 100;
const KEEP_DOCS = 4;
/** Versions fetched ahead of the one being summarised. Each fetch is a whole face, and the
 * server's share of it overlaps with the browser reading the one before. */
const AHEAD = 4;

export interface History {
  /** Saves, newest first. `null` while loading. */
  saves: HistoryEntry[] | null;
  /** The top line, or the reason there is none. */
  verifyLine: string;
  /** Per version: the one-line summary, once computed. */
  summaries: ReadonlyMap<number, string>;
  /** How many saves are listed so far. */
  shown: number;
  showOlder: () => void;
  /** The server has older saves than the ones listed so far. */
  hasOlder: boolean;
  error: string | null;
  /** The version being looked at, with its read-only document and what it changed. */
  picked: { version: number; doc: Document; change: SaveChange; outline: string[] } | null;
  pickVersion: (version: number) => Promise<void>;
  back: () => void;
}

/** Saves newest first, one per version (the newest entry for it), from entries oldest first. */
export function savesOf(entries: Iterable<HistoryEntry>): HistoryEntry[] {
  const byVersion = new Map<number, HistoryEntry>();
  for (const e of entries) if (e.entryType !== 'reencrypt') byVersion.set(e.designVersion, e);
  return [...byVersion.values()].sort((a, b) => b.designVersion - a.designVersion);
}

/** What is known of the chain: the entries fetched so far by seq, and whether older ones exist. */
export interface Fetched {
  entries: ReadonlyMap<number, HistoryEntry>;
  hasOlder: boolean;
}

const bySeq = (m: ReadonlyMap<number, HistoryEntry>) => [...m.values()].sort((a, b) => a.seq - b.seq);

/** The newest page, joined to what was fetched before. A page that does not reach back to what
 * is held (more changes landed meanwhile than a page holds) starts the list again from it. */
export function withNewest(held: Fetched | null, page: readonly HistoryEntry[]): Fetched {
  const full = page.length >= FETCH;
  const oldest = page.length > 0 ? Math.min(...page.map((e) => e.seq)) : null;
  const newestHeld = held != null && held.entries.size > 0 ? Math.max(...held.entries.keys()) : null;
  if (held == null || (full && oldest != null && newestHeld != null && oldest > newestHeld + 1)) {
    return { entries: new Map(page.map((e) => [e.seq, e])), hasOlder: full };
  }
  const entries = new Map(held.entries);
  for (const e of page) entries.set(e.seq, e);
  return { entries, hasOlder: held.hasOlder };
}

/** An older page, added below what is held. */
export function withOlder(held: Fetched, page: readonly HistoryEntry[]): Fetched {
  const entries = new Map(held.entries);
  for (const e of page) entries.set(e.seq, e);
  return { entries, hasOlder: page.length >= FETCH };
}

/** `edits` changes whenever the open design changes (yours or a peer's live change); the list
 * then catches up quietly, keeping what is picked. */
export function useHistory(organisationId: string, designId: string, active: boolean, edits = 0): History {
  const [fetched, setFetched] = useState<Fetched | null>(null);
  const saves = useMemo(() => (fetched == null ? null : savesOf(bySeq(fetched.entries))), [fetched]);
  const hasOlder = fetched?.hasOlder ?? false;
  const olderInFlight = useRef(false);
  const [verifyLine, setVerifyLine] = useState('Checking…');
  const [summaries, setSummaries] = useState<ReadonlyMap<number, string>>(new Map());
  const [shown, setShown] = useState(PAGE);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<History['picked']>(null);
  const cache = useRef(new Map<number, Document>());
  const ahead = useRef(new Map<number, Promise<Uint8Array>>());
  const changes = useRef(new Map<number, SaveChange>());
  const pickSeq = useRef(0);

  const load = useCallback(
    async (version: number): Promise<Document> => {
      const hit = cache.current.get(version);
      if (hit) {
        cache.current.delete(version); // re-insert as newest
        cache.current.set(version, hit);
        return hit;
      }
      const fetched = ahead.current.get(version);
      ahead.current.delete(version);
      const doc = readPlain(await (fetched ?? openDesign(organisationId, designId, version).then((o) => o.bytes)));
      cache.current.set(version, doc);
      while (cache.current.size > KEEP_DOCS) cache.current.delete(cache.current.keys().next().value as number);
      return doc;
    },
    [organisationId, designId],
  );

  /** Start fetching `version` if it is neither read nor on its way. */
  const prefetch = useCallback(
    (version: number) => {
      if (cache.current.has(version) || ahead.current.has(version)) return;
      const bytes = openDesign(organisationId, designId, version).then((o) => o.bytes);
      bytes.catch(() => undefined); // read, and reported, by `load` if it is ever wanted
      ahead.current.set(version, bytes);
    },
    [organisationId, designId],
  );

  // (Re)load the list and the check each time the panel opens.
  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    setFetched(null);
    setError(null);
    setPicked(null);
    setShown(PAGE);
    setSummaries(new Map());
    changes.current.clear();
    ahead.current.clear();
    setVerifyLine('Checking…');
    fetchHistory(organisationId, designId, { newest: FETCH })
      .then((page) => live && setFetched(withNewest(null, page)))
      .catch(() => live && setError("The saves couldn't be listed just now."));
    fetchVerify(organisationId, designId)
      .then((outcome) => live && setVerifyLine(verifyWords(outcome)))
      .catch(() => live && setVerifyLine("Couldn't be checked just now"));
    return () => {
      live = false;
    };
  }, [active, organisationId, designId]);

  const seen = useRef(edits);
  useEffect(() => {
    if (!active || seen.current === edits) {
      seen.current = edits;
      return undefined;
    }
    seen.current = edits;
    let live = true;
    const t = setTimeout(() => {
      fetchHistory(organisationId, designId, { newest: FETCH })
        .then((page) => live && setFetched((held) => withNewest(held, page)))
        .catch(() => undefined);
      fetchVerify(organisationId, designId)
        .then((outcome) => live && setVerifyLine(verifyWords(outcome)))
        .catch(() => undefined);
    }, 1500);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [active, edits, organisationId, designId]);

  // Summaries for the listed saves, newest first, one at a time (each needs the save and the one before it).
  useEffect(() => {
    if (saves == null) return undefined;
    let live = true;
    (async () => {
      // The last save held has its predecessor on the next page: it waits for that page.
      const end = Math.min(shown, hasOlder ? saves.length - 1 : saves.length);
      for (let i = 0; i < end && live; i += 1) {
        const v = saves[i]!.designVersion;
        if (changes.current.has(v)) continue;
        for (let j = i; j <= Math.min(i + AHEAD, end, saves.length - 1); j += 1) {
          if (!changes.current.has(saves[j]!.designVersion)) prefetch(saves[j]!.designVersion);
        }
        try {
          const after = await load(v);
          const prev = saves[i + 1];
          const before = prev ? await load(prev.designVersion) : null;
          if (!live) return;
          const change = describeSave(before, after);
          changes.current.set(v, change);
          setSummaries((m) => new Map(m).set(v, change.summary));
        } catch {
          if (live) setSummaries((m) => new Map(m).set(v, "Couldn't be read"));
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [saves, shown, hasOlder, load, prefetch]);

  const pickVersion = useCallback(
    async (version: number) => {
      const mine = ++pickSeq.current;
      try {
        const doc = await load(version);
        let change = changes.current.get(version);
        if (!change && saves) {
          const prev = saves[saves.findIndex((s) => s.designVersion === version) + 1];
          change = describeSave(prev ? await load(prev.designVersion) : null, doc);
          changes.current.set(version, change);
        }
        if (mine !== pickSeq.current) return; // a later pick or Back to now won
        setPicked({ version, doc, change: change!, outline: outlineIds(doc, change!.changed) });
        setError(null);
      } catch {
        setError("That save couldn't be opened just now.");
      }
    },
    [load, saves],
  );

  const showOlder = useCallback(() => {
    const next = shown + PAGE;
    setShown(next);
    if (fetched == null || !fetched.hasOlder || saves == null || next < saves.length - 1 || olderInFlight.current) return;
    const before = Math.min(...fetched.entries.keys());
    olderInFlight.current = true;
    fetchHistory(organisationId, designId, { newest: FETCH, before })
      .then((page) => setFetched((held) => (held == null ? held : withOlder(held, page))))
      .catch(() => setError("Older saves couldn't be listed just now."))
      .finally(() => {
        olderInFlight.current = false;
      });
  }, [shown, fetched, saves, organisationId, designId]);

  return {
    saves,
    verifyLine,
    summaries,
    // While older saves are on the server, the last one held is not listed: what it changed
    // needs the save before it, which is on the next page.
    shown: saves == null ? shown : Math.min(shown, hasOlder ? saves.length - 1 : saves.length),
    showOlder,
    hasOlder,
    error,
    picked,
    pickVersion,
    back: () => {
      pickSeq.current += 1;
      setPicked(null);
    },
  };
}
