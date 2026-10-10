// Path trace playback: when a result arrives the hops light one at a time, in order, then settle. The pure parts
// (step length, which hops are showing) and a small player that steps the shared trace store. Reduced motion, a
// click anywhere, or Esc goes straight to the settled state.
import type { TraceResult } from '../../engine/engine';
import { prefersReducedMotion } from '../drawing/motion';
import type { TraceStore } from './traceStore';

/** The longest the whole playback may take, in milliseconds. */
export const TRACE_TOTAL_MS = 1500;
/** The longest a single hop waits before the next lights, in milliseconds. */
export const TRACE_STEP_MAX_MS = 180;
/** The shortest a hop waits unless the total cap needs it shorter. */
export const TRACE_STEP_MIN_MS = 120;

/** How long each hop stays alone before the next: 120 to 180ms, shorter only when the total cap needs it. */
export function stepMs(hopCount: number): number {
  if (hopCount <= 1) return TRACE_STEP_MAX_MS;
  const fit = Math.floor(TRACE_TOTAL_MS / hopCount);
  return fit >= TRACE_STEP_MIN_MS ? Math.min(TRACE_STEP_MAX_MS, fit) : Math.max(1, fit);
}

/** The result with only its first `revealed` hops, or all of it when playback is not running. */
export function revealedResult(result: TraceResult, revealed: number | null): TraceResult {
  return revealed == null ? result : { ...result, hops: result.hops.slice(0, Math.max(0, revealed)) };
}

/** Where a hop row stands during playback: `null` when not playing. */
export function hopPhase(index: number, revealed: number | null): 'done' | 'now' | 'later' | null {
  if (revealed == null) return null;
  if (index < revealed - 1) return 'done';
  return index === revealed - 1 ? 'now' : 'later';
}

/** A short key for "the same trace again", so a live edit that reruns it does not replay it. */
export function traceKey(result: TraceResult): string {
  return `${result.from}|${result.to}|${result.flow}|${result.hops.length}`;
}

export interface TracePlayer {
  /** Light the hops one by one from the start (or settle at once when motion is reduced). */
  play(result: TraceResult): void;
  /** Settle now: every hop showing. */
  settle(): void;
  /** Stop without touching the store (the trace is going away). */
  cancel(): void;
}

export function createTracePlayer(store: TraceStore, reduced: () => boolean = prefersReducedMotion): TracePlayer {
  let timer: ReturnType<typeof setInterval> | null = null;
  let off: (() => void) | null = null;

  function cancel() {
    if (timer != null) clearInterval(timer);
    timer = null;
    off?.();
    off = null;
  }

  function settle() {
    cancel();
    const s = store.get();
    if (s.revealed != null) store.set({ ...s, revealed: null });
  }

  function listen() {
    if (typeof window === 'undefined') return;
    const onPointer = () => settle();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // The first Escape only skips the playback; it does not also close the panel.
      e.stopPropagation();
      e.preventDefault();
      settle();
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    off = () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }

  function play(result: TraceResult) {
    cancel();
    const count = result.hops.length;
    if (reduced() || count <= 1) {
      store.set({ result, revealed: null });
      return;
    }
    let shown = 1;
    store.set({ result, revealed: shown });
    listen();
    timer = setInterval(() => {
      shown += 1;
      if (shown >= count) {
        settle();
        return;
      }
      store.set({ result: store.get().result ?? result, revealed: shown });
    }, stepMs(count));
  }

  return { play, settle, cancel };
}
