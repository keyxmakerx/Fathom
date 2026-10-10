// Motion for cables a person is drawing right now: the slack in the live
// lead, and the one-time "pull tight, then pulse" on the cable they just made.

/** The most slack the live lead ever hangs with, in flow pixels. */
export const LIVE_SAG_MAX_PX = 56;
/** Slack per pixel of lead length: a longer lead hangs lower, up to the cap. */
export const LIVE_SAG_RATIO = 0.16;

/** How much the live lead hangs, from its length. Deterministic: proportional, then capped. */
export function liveSagPx(length: number): number {
  return Math.min(LIVE_SAG_MAX_PX, Math.max(0, length) * LIVE_SAG_RATIO);
}

/** The live lead between a fixed port and the pointer: a curve that hangs below the straight line by `liveSagPx` of its length. */
export function liveSagPath(x1: number, y1: number, x2: number, y2: number): string {
  const sag = liveSagPx(Math.hypot(x2 - x1, y2 - y1));
  const dx = x2 - x1;
  const dy = y2 - y1;
  const c1x = x1 + dx * 0.33;
  const c1y = y1 + dy * 0.33 + sag;
  const c2x = x2 - dx * 0.33;
  const c2y = y2 - dy * 0.33 + sag;
  return `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`;
}

/** How long a just-made cable may wait for its edge to appear. */
export const FRESH_WINDOW_MS = 3000;

interface Fresh {
  a: string;
  b: string;
  at: number;
}

let fresh: Fresh[] = [];
const played = new Set<string>();

/** The current person just made a cable between these two ports; its edge plays once when it appears. */
export function markFreshCable(portA: string, portB: string, now: number = Date.now()): void {
  fresh = fresh.filter((f) => now - f.at < FRESH_WINDOW_MS);
  fresh.push({ a: portA, b: portB, at: now });
}

/** Whether this cable is one the current person just made and has not yet played. Does not use it up, so it is safe to ask twice. */
export function isFreshCable(cableId: string, portIds: readonly string[], now: number = Date.now()): boolean {
  if (played.has(cableId) || portIds.length !== 2) return false;
  return fresh.some((f) => now - f.at < FRESH_WINDOW_MS && portIds.includes(f.a) && portIds.includes(f.b));
}

/** Records that this cable has played, so it never plays again. */
export function markCablePlayed(cableId: string): void {
  played.add(cableId);
}

/** Clears all state (tests). */
export function resetFreshCables(): void {
  fresh = [];
  played.clear();
}

/** How long the whole arrival lasts (pull, then pulse), in milliseconds. */
export const FRESH_PLAY_MS = 620;
