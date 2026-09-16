/**
 * The pure geometry the drawing is built on: no DOM, no React Flow, no
 * document mutation. Everything here is a number in, a number (or a
 * boolean, or an array) out, which is what makes it testable without a DOM
 * library per the brief's "tests without a DOM library" section.
 *
 * `docs/UI-SPEC.md` "Zoom is one continuous camera": there is one node
 * layout, in fixed pixels, at every zoom — the camera (React Flow's
 * viewport zoom) is what makes it look bigger or smaller. `U_PX` is that
 * layout's one constant, read at the **rack** stop (100%).
 *
 * Corrected 2026-09-16 (session 4 rendering defect): the previous version of
 * this file read `design/shell/Lenses.dc.html`'s 32px-per-U rack section as
 * the *rack* stop. It is not — that board is the close-in view where ports
 * are already hit targets, i.e. the **faceplate** stop, and reading it as
 * the rack stop's pixel size made a 42U rack (`design/shell/Main.dc.html`'s
 * own reference rack) draw 1344px tall against a drawing pane that is
 * nowhere near that height (819px, measured from the rendered shell at
 * 1440×900 — `1440×900` is the fixed size this project screenshots at).
 * Rebased so **100% (the rack stop) is instead defined as "the reference
 * 42U rack fits the drawing's height, header and a margin included"** —
 * `RACK_HEADER_PX + 42 * U_PX = 16 + 672 = 688`, leaving 131px of margin
 * inside 819px, comfortably more than one `RACK_GAP_PX`. `U_PX = 16` is
 * chosen, from that constraint, as the plainest number that clears it: not
 * fitted to the exact pixel (a fixed constant can't be — racks are not all
 * 42U and viewports are not all 819px tall; `Drawing.tsx`'s `fitView` is
 * what actually fits *a given* rack to *a given* viewport at the rack
 * stop), but the reference case for what "100%" means.
 *
 * `CAMERA_STOPS.closet` and `.faceplate` are then read off the boards
 * exactly as before, against this new base: `Main.dc.html`'s closet-stop
 * rack draws 14px per U (14/16 = 87.5, so `closet: 87.5`) and
 * `Lenses.dc.html`'s rack section draws 32px per U (32/16 = 200, so
 * `faceplate: 200`) — both exact against the boards' own literal numbers,
 * not "within a rounding pixel" the way the old (wrong) base needed.
 */

/** Pixels per U at the "rack" camera stop (100%) — see the file header for
 * how this is derived from the 42U reference rack fitting the drawing's
 * height, not from a board's literal pixel size. */
export const U_PX = 16;

/** The smallest a screen-space font is ever allowed to read as, no matter
 * how far out the camera is — `docs/UI-SPEC.md`'s approved closet-stop
 * board reads labels at 9–10px. Used by `counterScaledFontPx`. */
export const TEXT_FLOOR_PX = 9;

/**
 * The flow-space font size (what a node's CSS should set `font-size` to)
 * that keeps a label's on-screen size from dropping below `TEXT_FLOOR_PX`
 * as the camera zooms out, while still letting it grow normally once the
 * camera zooms in past the point `basePx` alone would already clear the
 * floor — UI-SPEC "Motion" #5, "zoom is one camera," never a second,
 * independently-scaling layer: this only ever *pins the floor*, it does
 * not opt the text out of the camera above that floor.
 *
 * On-screen size is `flow-space size × zoom` (React Flow scales the whole
 * pane); solving `flowSize × zoom = max(basePx × zoom, floorPx)` for
 * `flowSize` gives `max(basePx, floorPx / zoom)`.
 */
export function counterScaledFontPx(basePx: number, zoom: number, floorPx: number = TEXT_FLOOR_PX): number {
  if (!(zoom > 0)) return basePx;
  return Math.max(basePx, floorPx / zoom);
}

/**
 * The `scale` a port glyph (`components/ports`, `PortGlyphProps.scale`)
 * needs so it renders on screen at its **true size** — that component's own
 * doc: "`scale` 1 is the Legend board's true size, which is also the size
 * the Faceplate board draws every port at." A glyph drawn inside a chassis
 * box lives in flow space like everything else in it, so without this it
 * would render at `trueSize × zoom` on screen, not `trueSize`; this is the
 * inverse of that scaling (`flowSize × zoom = trueSize` ⇒
 * `flowSize = trueSize / zoom`), read as a multiplier on the glyph's own
 * `scale` prop rather than a pixel count. Exact, not floored like
 * `counterScaledFontPx` — a port glyph has one correct size, not a minimum.
 */
export function counterScaledGlyphScale(zoom: number): number {
  if (!(zoom > 0)) return 1;
  return 1 / zoom;
}

/** The tallest of the five port glyphs' true (`scale` 1) height — RJ45's
 * `frame(22, 20)` in `components/ports/Rj45.tsx`, `height = 20 + 1`.
 * `glyphScaleFittingBudget` uses this as a conservative stand-in for
 * "however tall the actual glyph in a given row is," rather than every
 * caller having to know each glyph kind's own true size. */
export const MAX_GLYPH_TRUE_HEIGHT_PX = 21;

/**
 * `counterScaledGlyphScale`'s true-size scale, clamped so the glyph's
 * flow-space height never exceeds `availableFlowPx` — a 1U chassis box has
 * very little flow-space height to give a header row and a port row both
 * (`U_PX`'s file header: rebasing it to fit the 42U reference rack halved
 * what a 1U row has to work with), and a glyph that does not fit would
 * either overflow and be clipped by `.drawing-chassis`'s hidden overflow or
 * silently vanish, neither of which is "drawn as absent" — shrinking it to
 * fit is the honest option `ChassisNode.tsx` has left once a caller reports
 * how much room the ports row actually got.
 */
export function glyphScaleFittingBudget(
  zoom: number,
  availableFlowPx: number,
  trueHeightPx: number = MAX_GLYPH_TRUE_HEIGHT_PX,
): number {
  if (availableFlowPx <= 0) return 0;
  const desired = counterScaledGlyphScale(zoom);
  const desiredFlowPx = trueHeightPx * desired;
  return desiredFlowPx <= availableFlowPx ? desired : desired * (availableFlowPx / desiredFlowPx);
}

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
 *
 * Derived against `U_PX`'s new base (see the file header): `closet` reads
 * 14px per U on the approved board, `14 / 16 × 100 = 87.5`; `faceplate`
 * reads 32px per U, `32 / 16 × 100 = 200`. Both exact.
 */
export const CAMERA_STOPS = { closet: 87.5, rack: 100, faceplate: 200 } as const;
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
