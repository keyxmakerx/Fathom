// Camera and canvas motion helpers, shared by the drawing and its edges.
// Everything here honours the person's "reduce motion" setting.

/** True when the person has asked the system for less motion. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Ease-out (cubic): quick start, soft stop. */
export function easeOut(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

/** How long a camera glide takes, in milliseconds. */
export const GLIDE_MS = 300;

/** Camera glide options, read fresh at each call so a change to the reduce-motion setting applies at once. */
export function glideOptions(): { duration: number; ease: (t: number) => number; interpolate: 'linear' } {
  return { duration: prefersReducedMotion() ? 0 : GLIDE_MS, ease: easeOut, interpolate: 'linear' };
}

/** How long a device's landing in the rack plays, in milliseconds. */
export const SETTLE_MS = 250;
