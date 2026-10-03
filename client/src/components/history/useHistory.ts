// The History panel's data: the saves, the server's check, one-line summaries computed in the
// browser, and the version being looked at. Version bodies are fetched on demand and only the
// newest few are kept.

import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchHistory, fetchVerify, verifyWords, type HistoryEntry } from '../../api/history';
import { openDesign } from '../../api/payload';
import { describeSave, outlineIds, type SaveChange } from '../../document/historyDiff';
import type { Document } from '../../document/model';
import { readPlain } from '../../document/plain';

const PAGE = 15;
const KEEP_DOCS = 4;

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
  error: string | null;
  /** The version being looked at, with its read-only document and what it changed. */
  picked: { version: number; doc: Document; change: SaveChange; outline: string[] } | null;
  pickVersion: (version: number) => Promise<void>;
  back: () => void;
}

/** `edits` changes whenever the open design changes (yours or a peer's live change); the list
 * then catches up quietly, keeping what is picked. */
export function useHistory(organisationId: string, designId: string, active: boolean, edits = 0): History {
  const [saves, setSaves] = useState<HistoryEntry[] | null>(null);
  const [verifyLine, setVerifyLine] = useState('Checking…');
  const [summaries, setSummaries] = useState<ReadonlyMap<number, string>>(new Map());
  const [shown, setShown] = useState(PAGE);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<History['picked']>(null);
  const cache = useRef(new Map<number, Document>());
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
      const doc = readPlain((await openDesign(organisationId, designId, version)).bytes);
      cache.current.set(version, doc);
      while (cache.current.size > KEEP_DOCS) cache.current.delete(cache.current.keys().next().value as number);
      return doc;
    },
    [organisationId, designId],
  );

  // (Re)load the list and the check each time the panel opens.
  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    setSaves(null);
    setError(null);
    setPicked(null);
    setShown(PAGE);
    setSummaries(new Map());
    changes.current.clear();
    setVerifyLine('Checking…');
    fetchHistory(organisationId, designId)
      .then((entries) => {
        if (!live) return;
        const byVersion = new Map<number, (typeof entries)[number]>();
        for (const e of entries) if (e.entryType !== 'reencrypt') byVersion.set(e.designVersion, e);
        setSaves([...byVersion.values()].sort((a, b) => b.designVersion - a.designVersion));
      })
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
      fetchHistory(organisationId, designId)
        .then((entries) => {
          if (!live) return;
          const byVersion = new Map<number, (typeof entries)[number]>();
          for (const e of entries) if (e.entryType !== 'reencrypt') byVersion.set(e.designVersion, e);
          setSaves([...byVersion.values()].sort((a, b) => b.designVersion - a.designVersion));
        })
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
      for (let i = 0; i < Math.min(shown, saves.length) && live; i += 1) {
        const v = saves[i]!.designVersion;
        if (changes.current.has(v)) continue;
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
  }, [saves, shown, load]);

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

  return {
    saves,
    verifyLine,
    summaries,
    shown,
    showOlder: () => setShown((n) => n + PAGE),
    error,
    picked,
    pickVersion,
    back: () => {
      pickSeq.current += 1;
      setPicked(null);
    },
  };
}
