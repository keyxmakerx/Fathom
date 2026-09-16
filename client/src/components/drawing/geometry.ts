/**
 * The pure geometry the drawing is built on: no DOM, no React Flow, no
 * document mutation. Everything here is a number in, a number (or a
 * boolean, or an array) out, which is what makes it testable without a DOM
 * library per the brief's "tests without a DOM library" section.
 *
 * `docs/UI-SPEC.md` "Zoom is one continuous camera": there is one node
 * layout, in fixed pixels, at every zoom — the camera (React Flow's
 * viewport zoom) is what makes it look bigger or smaller. `U_PX` is that
 * layout's one constant, and it is not invented: `design/shell/Lenses.dc.html`
 * draws its rack section at 32px per U (11 U over 352px, both boards'
 * literal SVG numbers), and `design/shell/Main.dc.html`'s closet-stop rack
 * draws 14px per U — 14/32 = 0.4375, which is why `CAMERA_STOPS.closet`
 * below is set to 45 (of the 100 the rack stop reads): the two boards agree
 * to within a rounding pixel and neither invents a new ratio.
 */

/** Pixels per U at the "rack" camera stop (100%). `design/shell/Lenses.dc.html`. */
export const U_PX = 32;

/** The rail's width each side of the device column: `design/shell/Main.dc.html`'s
 * rack frame is 300px wide with two 28px rails either side of a 244px
 * device column (`rect x="0" width="28"`, `rect x="272" width="28"` inside
 * a 300px frame). */
export const RAIL_PX = 28;

/** The device column's width, both boards: 300 (frame) − 28 × 2 (rails). */
export const RACK_INNER_PX = 244;

/** Room above the frame for the rack's own label row (`design/shell/Main.dc.html`'s
 * `text y="-1"` sitting above the frame's `y="0"`). */
export const RACK_HEADER_PX = 16;

/**
 * Camera stops, as percentages matching the shell's `zoom` convention (the
 * bar shows `100%` — `design/shell/Main.dc.html`). This drawing only spans
 * three of UI-SPEC's seven stops (closet, rack, faceplate); estate, site,
 * building and inside are other surfaces' concern.
 *
 * `docs/UI-SPEC.md` "Owed to the boards" names the port hit-target zoom as
 * a number this page has never specified and says to name it "when the
 * faceplate surface is built... rather than in the code" — this is that
 * surface, so the number is named here rather than left silently chosen.
 */
export const CAMERA_STOPS = { closet: 45, rack: 100, faceplate: 220 } as const;
export type CameraStop = keyof typeof CAMERA_STOPS;
const STOP_ORDER: CameraStop[] = ['closet', 'rack', 'faceplate'];

/** Which named stop a zoom percentage reads as right now — nearest stop by
 * absolute distance, ties won by the earlier (smaller) stop. */
export function cameraStopAt(zoomPercent: number): CameraStop {
  let closest: CameraStop = STOP_ORDER[0];
  let bestDistance = Infinity;
  for (const stop of STOP_ORDER) {
    const distance = Math.abs(CAMERA_STOPS[stop] - zoomPercent);
    if (distance < bestDistance) {
      bestDistance = distance;
      closest = stop;
    }
  }
  return closest;
}

/** UI-SPEC "Ports": "Ports fade in as they become big enough to hit," never
 * tiny dots. Ramped from invisible at the rack stop to fully opaque at the
 * faceplate stop; patch-facing gear's "ports always" override belongs to
 * the caller (it knows the device's role), not to this pure function. */
export function portOpacity(zoomPercent: number): number {
  const { rack, faceplate } = CAMERA_STOPS;
  if (zoomPercent <= rack) return 0;
  if (zoomPercent >= faceplate) return 1;
  return (zoomPercent - rack) / (faceplate - rack);
}

/** The occupied U range of a chassis-shaped thing: `positionU` is its
 * lowest (bottom) U, per rack-mount convention, occupying
 * `[positionU, positionU + heightU - 1]`. */
export function occupiedRange(c: { positionU: number; heightU: number }): [number, number] {
  return [c.positionU, c.positionU + c.heightU - 1];
}

export function rangesOverlap(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

/**
 * Would a chassis of `heightU` at `positionU` overlap anything already in
 * the rack (excluding, when moving, itself), or run off either end of the
 * rack? Placement only — this never looks at cabling.
 */
export function overlapsRack(
  rack: { heightU: number; chassis: ReadonlyArray<{ id: string; positionU: number; heightU: number }> },
  candidate: { id?: string; positionU: number; heightU: number },
): boolean {
  if (candidate.positionU < 1) return true;
  if (candidate.positionU + candidate.heightU - 1 > rack.heightU) return true;
  const range = occupiedRange(candidate);
  return rack.chassis.some((c) => {
    if (candidate.id != null && c.id === candidate.id) return false;
    return rangesOverlap(range, occupiedRange(c));
  });
}

/**
 * Snap a drop's pixel offset — measured from the top of the rack's device
 * column, i.e. below `RACK_HEADER_PX` — to the U it would put the top of a
 * `heightU`-tall run at, returning that run's `positionU` (its bottom U).
 * Clamped so the run stays inside the rack; never returns an overlap
 * decision, only where the drop asked to land.
 */
export function snapDropToU(rackHeightU: number, offsetPxFromDeviceColumnTop: number, heightU: number): number {
  const topRowFromTop = Math.round(offsetPxFromDeviceColumnTop / U_PX);
  const positionU = rackHeightU - topRowFromTop - heightU + 1;
  const maxPositionU = Math.max(rackHeightU - heightU + 1, 1);
  return Math.min(Math.max(positionU, 1), maxPositionU);
}

/** The pixel offset from the top of the device column at which a run
 * starting at `positionU` (bottom U) draws — `snapDropToU`'s inverse, used
 * to lay out chassis and free-run rectangles from the same arithmetic. */
export function uToOffsetPx(rackHeightU: number, positionU: number, heightU: number): number {
  const topU = positionU + heightU - 1;
  return (rackHeightU - topU) * U_PX;
}

/**
 * Free runs in top-down render order — the order the frame draws its
 * hatched rectangles in. The view's own array order is not guaranteed, so
 * this sorts by the top of the run (`toU`) descending, then by `fromU`
 * descending for two runs that somehow share a top.
 */
export function sortFreeRuns<T extends { fromU: number; toU: number }>(runs: readonly T[]): T[] {
  return [...runs].sort((a, b) => b.toU - a.toU || b.fromU - a.fromU);
}

/**
 * Which rack (if any) a flow-space point falls inside, given the session's
 * rack layout (`Drawing.tsx`'s `rackPositions` state). Used for both a
 * palette drop and a chassis drag-stop, so it lives here rather than in the
 * component, where it can be exercised without a DOM.
 */
export function rackAtPoint<R extends { id: string; heightU: number }>(
  racks: readonly R[],
  positions: Readonly<Record<string, { x: number; y: number }>>,
  point: { x: number; y: number },
  rackWidthPx: number,
): R | null {
  for (const rack of racks) {
    const pos = positions[rack.id];
    if (pos == null) continue;
    const height = RACK_HEADER_PX + rack.heightU * U_PX;
    if (point.x >= pos.x && point.x <= pos.x + rackWidthPx && point.y >= pos.y && point.y <= pos.y + height) {
      return rack;
    }
  }
  return null;
}
