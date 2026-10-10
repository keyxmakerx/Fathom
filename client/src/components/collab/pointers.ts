// Other people's pointers on the canvas: how often ours is sent, and when a pointer that has stopped
// moving fades. Pure; the timers and clock are handed in so tests control them.

export interface Point {
  x: number;
  y: number;
}

/** Someone else's pointer, in canvas (flow) coordinates. */
export interface PointerInfo extends Point {
  account: string;
  name: string;
  initials: string;
}

/** At most 8 updates a second. The server allows a little more, so a late timer never trips it. */
export const POINTER_GAP_MS = 125;

/**
 * The gap between updates when `others` people are there to see them. Each update is a signed request
 * (a nonce, then the post), so a crowded design is sent less often rather than all at the full rate.
 */
export function pointerGapMs(others: number): number {
  if (others <= 4) return POINTER_GAP_MS;
  return others <= 14 ? POINTER_GAP_MS * 2 : POINTER_GAP_MS * 4;
}

/** A pointer that has not moved for this long starts to fade, and is gone at `POINTER_GONE_MS`. */
export const POINTER_FADE_MS = 4000;
export const POINTER_GONE_MS = 5000;

const tenth = (v: number) => Math.round(v * 10) / 10;
const same = (a: Point | null | undefined, b: Point | null | undefined) => (a == null || b == null ? a === b : a.x === b.x && a.y === b.y);

export interface ThrottleDeps {
  /** Sends the position (`null`: it left). False when nothing was sent, e.g. nobody else is here. */
  send(point: Point | null): boolean;
  now(): number;
  /** The gap to keep between sends right now; the default is `POINTER_GAP_MS`. */
  gap?(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/**
 * Sends the pointer at most 8 times a second, and not at all when it has not moved (to a tenth of a
 * canvas unit). A move inside the gap is held and the latest one sent when the gap ends. Leaving sends
 * at once, whatever the gap, so the other side never shows a pointer that went away.
 */
export class PointerThrottle {
  private readonly d: ThrottleDeps;
  private lastSent: Point | null | undefined;
  private lastAt = Number.NEGATIVE_INFINITY;
  private latest: Point | null = null;
  private timer: unknown;

  constructor(deps: ThrottleDeps) {
    this.d = deps;
  }

  move(point: Point): void {
    this.latest = { x: tenth(point.x), y: tenth(point.y) };
    if (this.timer !== undefined) return;
    const wait = this.lastAt + (this.d.gap?.() ?? POINTER_GAP_MS) - this.d.now();
    if (wait <= 0) this.fire();
    else
      this.timer = this.d.setTimer(() => {
        this.timer = undefined;
        this.fire();
      }, wait);
  }

  /** The pointer left the canvas or the tab was hidden. */
  leave(): void {
    this.latest = null;
    if (this.timer !== undefined) {
      this.d.clearTimer(this.timer);
      this.timer = undefined;
    }
    if (this.lastSent != null && this.d.send(null)) {
      this.lastSent = null;
      this.lastAt = this.d.now();
    }
  }

  /** The other side may have forgotten us (the stream reopened): the next move is sent whatever it is. */
  forget(): void {
    this.lastSent = undefined;
  }

  dispose(): void {
    if (this.timer !== undefined) this.d.clearTimer(this.timer);
    this.timer = undefined;
  }

  private fire(): void {
    const point = this.latest;
    if (point === null || same(point, this.lastSent)) return;
    if (this.d.send(point)) {
      this.lastSent = point;
      this.lastAt = this.d.now();
    }
  }
}

export interface Tracked extends PointerInfo {
  /** When this pointer last moved, as seen here. */
  movedAt: number;
}

/** Folds a fresh list of pointers into what is tracked: new or moved ones are stamped `now`, the rest keep their stamp, gone ones drop. */
export function trackMoves(prev: ReadonlyMap<string, Tracked>, list: readonly PointerInfo[], now: number): Map<string, Tracked> {
  const next = new Map<string, Tracked>();
  for (const p of list) {
    const before = prev.get(p.account);
    const moved = before === undefined || before.x !== p.x || before.y !== p.y;
    next.set(p.account, { ...p, movedAt: moved ? now : before.movedAt });
  }
  return next;
}

/** 1 while the pointer is moving, fading to 0 over its last second of idleness. */
export function pointerOpacity(movedAt: number, now: number): number {
  const idle = now - movedAt;
  if (idle <= POINTER_FADE_MS) return 1;
  if (idle >= POINTER_GONE_MS) return 0;
  return 1 - (idle - POINTER_FADE_MS) / (POINTER_GONE_MS - POINTER_FADE_MS);
}
