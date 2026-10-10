import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { ClosetView } from './contract';
import { prefersReducedMotion, SETTLE_MS } from './motion';
import { chassisNodeId } from './nodeId';
import '../../styles/settle.css';

/** A device just placed, waiting for the document to show it. */
interface PendingPlace {
  rackId: string;
  positionU: number;
  /** Device ids already in that rack when the drop happened. */
  known: ReadonlySet<string>;
  at: number;
}

/** How long a placed device may take to arrive before the wait is dropped. */
const PLACE_WAIT_MS = 3000;

/** The device that appeared at `positionU` in `rackId` since `known` was taken, or null. */
export function findPlaced(view: Pick<ClosetView, 'racks'>, rackId: string, positionU: number, known: ReadonlySet<string>): string | null {
  const rack = view.racks.find((r) => r.id === rackId);
  const hit = rack?.chassis.find((c) => c.positionU === positionU && !known.has(c.id));
  return hit?.id ?? null;
}

/** Plays a short, soft landing on a device that has just been placed or moved into a rack. */
export function useSettle(containerRef: RefObject<HTMLElement | null>, view: Pick<ClosetView, 'racks'>) {
  const pending = useRef<PendingPlace | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const live = timers.current;
    return () => {
      live.forEach((t) => clearTimeout(t));
      live.clear();
    };
  }, []);

  const play = useCallback(
    (chassisId: string, triesLeft = 12) => {
      if (prefersReducedMotion()) return;
      const root = containerRef.current;
      if (root == null) return;
      const wrap = root.querySelector(`[data-id="${CSS.escape(chassisNodeId(chassisId))}"] .drawing-chassis-wrap`);
      if (wrap == null) {
        // The box may not be on screen for a frame or two yet.
        if (triesLeft > 0) requestAnimationFrame(() => play(chassisId, triesLeft - 1));
        return;
      }
      wrap.classList.remove('drawing-chassis-wrap--settle');
      void (wrap as HTMLElement).offsetWidth; // restart the animation if it was already playing
      wrap.classList.add('drawing-chassis-wrap--settle');
      const t = setTimeout(() => {
        wrap.classList.remove('drawing-chassis-wrap--settle');
        timers.current.delete(t);
      }, SETTLE_MS + 40);
      timers.current.add(t);
    },
    [containerRef],
  );

  /** An existing device was moved into a rack: it lands where it is now. */
  const settleMoved = useCallback((chassisId: string) => requestAnimationFrame(() => play(chassisId)), [play]);

  /** A new device was dropped from the palette: it lands once the document shows it. */
  const settlePlaced = useCallback(
    (rackId: string, positionU: number) => {
      const rack = view.racks.find((r) => r.id === rackId);
      pending.current = { rackId, positionU, known: new Set((rack?.chassis ?? []).map((c) => c.id)), at: Date.now() };
    },
    [view.racks],
  );

  useEffect(() => {
    const p = pending.current;
    if (p == null) return;
    if (Date.now() - p.at > PLACE_WAIT_MS) {
      pending.current = null;
      return;
    }
    const id = findPlaced(view, p.rackId, p.positionU, p.known);
    if (id == null) return;
    pending.current = null;
    play(id);
  }, [view, play]);

  return { settleMoved, settlePlaced };
}
