// Runs one trace for the open design: the start, the far end, the optional flow. The engine and mirror are the
// ones the page already holds (RacksPlace); this boots nothing of its own.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Document } from '../../document/model';
import { deviceOfChassis } from '../../document/firmware';
import type { ChassisView, ClosetView, FixtureView } from '../../document/view';
import type { TraceResult } from '../../engine/engine';
import type { Mirror } from '../../engine/mirror';
import { searchDesign } from '../shell/search';
import { parseFlow, readAddress } from './traceModel';
import { createTracePlayer, traceKey } from './tracePlayback';
import { createTraceStore, type TraceStore } from './traceStore';

export interface TraceEnd {
  deviceId: string;
  label: string;
}

export interface TraceController {
  open: boolean;
  store: TraceStore;
  from: TraceEnd | null;
  query: string;
  /** A device picked from the list, or null while the box holds an address or nothing. */
  target: TraceEnd | null;
  flowText: string;
  /** True when the flow box holds something that is not `TCP 445` or `UDP 53`. */
  flowBad: boolean;
  suggestions: TraceEnd[];
  result: TraceResult | null;
  error: string;
  /** A trace is asked for and its answer has not come back. */
  pending: boolean;
  openFrom(chassisId: string): void;
  /** Opens a whole question at once: from a device to an address or device name, with a flow (may be empty). */
  ask(chassisId: string, to: string, flowText: string): void;
  /** Opens a trace already filled in: a lesson's trace step asks for one. `from` may be a device or a port. */
  openWith(from: TraceEnd, to: TraceEnd, flowText: string): void;
  close(): void;
  setQuery(text: string): void;
  pick(end: TraceEnd): void;
  setFlowText(text: string): void;
  /** Plays the hops again, one by one. */
  replay(): void;
}

/** The trace end for a device, found by its chassis id wherever it sits: a rack unit, a shelf slot, a wall,
 * desk or ceiling, or nowhere yet. A shelf or surface device's Device is read off the design itself. */
function endFor(view: Pick<ClosetView, 'racks' | 'unplaced'> & Partial<Pick<ClosetView, 'surfaces'>>, doc: Document | null, chassisId: string): TraceEnd | null {
  for (const rack of view.racks) for (const c of rack.chassis) if (c.id === chassisId) return endOf(c);
  const loose = view.unplaced.find((c) => c.id === chassisId);
  if (loose != null) return endOf(loose);
  const label = offRackLabel(view, chassisId);
  if (label == null || doc == null) return null;
  const deviceId = deviceOfChassis(doc, chassisId);
  return deviceId == null ? null : { deviceId, label };
}

function offRackLabel(view: Pick<ClosetView, 'racks'> & Partial<Pick<ClosetView, 'surfaces'>>, chassisId: string): string | null {
  for (const rack of view.racks) for (const shelf of rack.shelves ?? []) for (const o of shelf.occupants) if (o.id === chassisId && o.kind === 'chassis') return o.label;
  const walk = (list: readonly FixtureView[]): string | null => {
    for (const f of list) {
      if (f.id === chassisId && f.kind === 'chassis') return f.label;
      const inner = walk(f.fixtures);
      if (inner != null) return inner;
    }
    return null;
  };
  for (const surface of view.surfaces ?? []) {
    const hit = walk(surface.fixtures);
    if (hit != null) return hit;
  }
  return null;
}

const endOf = (c: ChassisView): TraceEnd => ({ deviceId: c.deviceId, label: c.hostname || c.model });

interface Deps {
  doc: Document | null;
  view: Pick<ClosetView, 'racks' | 'unplaced'> & Partial<Pick<ClosetView, 'surfaces'>>;
  boot: () => Promise<Mirror>;
  mirrorNow: (load?: boolean) => Mirror | null;
}

export function useTraceController({ doc, view, boot, mirrorNow }: Deps): TraceController {
  const store = useMemo(createTraceStore, []);
  const player = useMemo(() => createTracePlayer(store), [store]);
  const playedKey = useRef('');
  useEffect(() => () => player.cancel(), [player]);
  const [from, setFrom] = useState<TraceEnd | null>(null);
  const [query, setQueryText] = useState('');
  const [target, setTarget] = useState<TraceEnd | null>(null);
  const [flowText, setFlowText] = useState('');
  const [result, setResult] = useState<TraceResult | null>(null);
  const [error, setError] = useState('');
  const runRef = useRef(0);

  const flow = parseFlow(flowText);
  const address = target == null ? readAddress(query) : null;
  const to = target?.deviceId ?? address;

  useEffect(() => {
    if (from == null || to == null || flow === null) {
      setResult(null);
      setError('');
      player.cancel();
      playedKey.current = '';
      store.set({ result: null });
      return undefined;
    }
    const run = ++runRef.current;
    void (async () => {
      try {
        await boot();
        const mirror = mirrorNow(true);
        if (mirror == null || run !== runRef.current) return;
        const r = mirror.trace(from.deviceId, to, flow === 'none' ? undefined : flow);
        if (run !== runRef.current) return;
        setResult(r);
        setError('');
        // A new answer plays hop by hop; the same one coming back after a live edit just updates in place.
        const key = traceKey(r);
        if (key === playedKey.current) store.set({ result: r, revealed: store.get().revealed ?? null });
        else {
          playedKey.current = key;
          player.play(r);
        }
      } catch (e) {
        if (run !== runRef.current) return;
        setResult(null);
        setError(e instanceof Error ? e.message : 'The trace could not run.');
        player.cancel();
        playedKey.current = '';
        store.set({ result: null });
      }
    })();
    return undefined;
    // `doc` re-runs the trace when the design changes under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from?.deviceId, to, flowText, doc]);

  const suggestions = useMemo(() => {
    if (target != null || query.trim() === '' || address != null) return [];
    const out: TraceEnd[] = [];
    for (const hit of searchDesign(view, query, doc ?? undefined, 24)) {
      const kind = hit.selection?.kind;
      if (hit.group !== 'Devices' || (kind !== 'chassis' && kind !== 'occupant' && kind !== 'fixture')) continue;
      const end = endFor(view, doc, hit.selection.id);
      if (end != null && end.deviceId !== from?.deviceId) out.push(end);
    }
    return out.slice(0, 6);
  }, [view, doc, query, target, address, from?.deviceId]);

  const openFrom = useCallback(
    (chassisId: string) => {
      const end = endFor(view, doc, chassisId);
      if (end == null) return;
      setFrom(end);
      setQueryText('');
      setTarget(null);
      setResult(null);
      setError('');
    },
    [view, doc],
  );

  const ask = useCallback(
    (chassisId: string, toText: string, flowWords: string) => {
      const end = endFor(view, doc, chassisId);
      if (end == null) return;
      setFrom(end);
      setQueryText(toText);
      setTarget(null);
      setFlowText(flowWords);
      setResult(null);
      setError('');
    },
    [view, doc],
  );

  const openWith = useCallback((start: TraceEnd, end: TraceEnd, flow: string) => {
    setFrom(start);
    setTarget(end);
    setQueryText(end.label);
    setFlowText(flow);
    setResult(null);
    setError('');
  }, []);

  const close = useCallback(() => {
    runRef.current += 1;
    setFrom(null);
    setQueryText('');
    setTarget(null);
    setFlowText('');
    setResult(null);
    setError('');
    player.cancel();
    playedKey.current = '';
    store.set({ result: null });
  }, [store, player]);

  const replay = useCallback(() => {
    const r = store.get().result;
    if (r != null) player.play(r);
  }, [store, player]);

  const setQuery = useCallback((text: string) => {
    setQueryText(text);
    setTarget(null);
  }, []);

  const pick = useCallback((end: TraceEnd) => {
    setTarget(end);
    setQueryText(end.label);
  }, []);

  return {
    open: from != null,
    store,
    from,
    query,
    target,
    flowText,
    flowBad: flow === null,
    suggestions,
    result,
    error,
    pending: from != null && to != null && flow !== null && result == null && error === '',
    openFrom,
    ask,
    openWith,
    close,
    setQuery,
    pick,
    setFlowText,
    replay,
  };
}
