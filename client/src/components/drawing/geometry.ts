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

import type { CableKind } from './contract';

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
 * bar shows `100%` — `design/shell/Main.dc.html`). This drawing spans four
 * of UI-SPEC's seven stops (closet, rack, faceplate, inside); estate, site
 * and building are other surfaces' concern.
 *
 * `docs/UI-SPEC.md` "Owed to the boards" names the port hit-target zoom as
 * a number this page has never specified and says to name it "when the
 * faceplate surface is built... rather than in the code" — this is that
 * surface, so the number is named here rather than left silently chosen.
 *
 * Derived against `U_PX`'s new base (see the file header): `closet` reads
 * 14px per U on the approved board, `14 / 16 × 100 = 87.5`; `faceplate`
 * reads 32px per U, `32 / 16 × 100 = 200`. Both exact.
 *
 * `inside: 300` — UI-SPEC "Zoom is one continuous camera" names *inside* as
 * "the approved Hypervisor and Firewall boards, named as a stop," beyond
 * *faceplate*. Unlike `closet`/`faceplate` above, `design/rebuild/Firewall.dc.html`'s
 * masthead carries no literal per-U pixel size to derive a stop from — its
 * chassis draws "open," at a scale that answers "how much room does a zone
 * need to read," not "how many pixels is a U here" (its ports sit against
 * the panel edge at the faceplate's own scale, then everything past that
 * edge is drawn at whatever size the regions inside need, exactly UI-SPEC's
 * own "the jacks on the panel at the edge are the same ports you cabled" —
 * the two zooms coexist in one picture, not a single px/U ratio the way a
 * rack elevation's board reads). `300` is chosen instead as the plainest
 * number that reads as "one stop past the faceplate" in the same 100%
 * increment `rack → faceplate` already uses (100 → 200), never fitted to a
 * board pixel that is not there.
 */
export const CAMERA_STOPS = { closet: 87.5, rack: 100, faceplate: 200, inside: 300 } as const;
export type CameraStop = keyof typeof CAMERA_STOPS;
const STOP_ORDER: CameraStop[] = ['closet', 'rack', 'faceplate', 'inside'];

/**
 * The one pair of zoom limits `Drawing.tsx` gives React Flow
 * (`minZoom`/`maxZoom`), derived here rather than inlined there so every
 * `CAMERA_STOPS` member is provably reachable by the wheel/pinch that
 * `zoomOnScroll` drives, not only by the bar's stepped +/- (which pushes the
 * controlled `viewport` directly and is not clamped by these two — the
 * "two controls, two different ceilings" defect this fixes is specifically
 * the wheel/pinch side, d3's own `scaleExtent`). `MAX_ZOOM` covers the
 * furthest-in named stop (`inside`, deepest in `STOP_ORDER`) with the same
 * 0.3 (30 percentage points) of headroom past it that `faceplate` used to
 * get past `rack`, so scrolling one tick further than the deepest stop does
 * not immediately clamp back to it and read as "snapped out".
 */
export const MIN_ZOOM = CAMERA_STOPS.closet / 100 - 0.1;
export const MAX_ZOOM = CAMERA_STOPS.inside / 100 + 0.3;

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

/** `.drawing-chassis__ports`'s own `gap: 2px` (`drawing.css`) — kept here so
 * `portRowBudgetPx` divides the same pixel count the CSS actually spends
 * between rows, not a guess at it. */
export const PORT_ROW_GAP_PX = 2;

/**
 * The flow-space height one port row may use, out of a chassis's total
 * ports budget — session 5's fix for the "1U box's port glyphs overflow its
 * bottom edge at the faceplate stop" defect (`docs/STATE.md`, carried from
 * session 4): `ChassisNode.tsx` used to hand `glyphScaleFittingBudget` the
 * *whole* ports budget for every row, so a paired top/bottom faceplate
 * (`document/view.ts`'s `rowNumber` — two rows sharing one 1U box) sized
 * each row as if it alone owned all the height, and the two rows together
 * asked for roughly double what the box actually has. Dividing the budget
 * by the row count first (minus the gaps between them) is what makes each
 * row's own share honest. `numRows` is always at least 1 in practice (a
 * chassis with ports has at least one row), but this clamps anyway rather
 * than divide by zero for an empty chassis.
 */
export function portRowBudgetPx(totalBudgetPx: number, numRows: number, rowGapPx: number = PORT_ROW_GAP_PX): number {
  const rows = Math.max(1, numRows);
  return Math.max(0, (totalBudgetPx - (rows - 1) * rowGapPx) / rows);
}

/** The sag's cap — `docs/UI-SPEC.md` "Cables": "more on longer vertical
 * runs, capped." A cable between two far racks never bows further than
 * this, no matter how tall the run. */
export const CABLE_SAG_MAX_PX = 64;

/** How much of the vertical run's length becomes sag before the cap takes
 * over — chosen so a same-row jump (a few U of vertical run) reads as a
 * gentle droop and a riser-to-floor run reads as a real hanging slack
 * without needing per-cable tuning. */
const CABLE_SAG_RATIO = 0.22;

/** UI-SPEC "Cables": "Every cable bows right and down, more on longer
 * vertical runs, capped." Purely a function of the vertical distance
 * travelled — a same-row jump between two adjacent ports sags only a
 * little; a cable climbing several racks' worth of U sags up to
 * `CABLE_SAG_MAX_PX` and no further. */
export function cableSagPx(verticalRunPx: number): number {
  return Math.min(CABLE_SAG_MAX_PX, Math.abs(verticalRunPx) * CABLE_SAG_RATIO);
}

/** UI-SPEC "Cables" + "Lanes": data bows right, power keeps "its own lane
 * on the other side from data" — the two lanes never share a side, so a
 * power run and a data run leaving the same rack edge are never mistaken
 * for one another even when they happen to travel the same distance. */
export function laneBiasPx(kind: CableKind): number {
  return kind === 'power' ? -CABLE_SAG_MAX_PX * 0.5 : CABLE_SAG_MAX_PX * 0.5;
}

/**
 * The sagging cable path between two flow-space points — the live drag's
 * droop and the settled cable's curve are the same curve
 * (`docs/UI-SPEC.md` "Motion" #1: "Cable droops as you pull it — slack you
 * would really have," i.e. the same slack the settled cable keeps once it
 * is dropped). Bows right and down: the first control point sits to the
 * lower-right of the start, the second to the upper-right of the end, so
 * the curve reads as real cable weight rather than a mechanical arc.
 * `laneBiasPx` shifts both control points sideways for a power cable, so
 * it never draws through the same lane a data cable would.
 */
export function cableSagPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  kind: CableKind = 'copper',
): string {
  const sag = cableSagPx(y2 - y1);
  const bias = laneBiasPx(kind);
  const c1x = x1 + sag + bias;
  const c1y = y1 + sag * 0.6;
  const c2x = x2 + sag * 0.35 + bias;
  const c2y = y2 - sag * 0.5;
  return `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`;
}

/**
 * Above the rack or below it — UI-SPEC "Portals": "Above or below the
 * rack" — decided by the port's own row in the rack: read here as which
 * half of the rack the chassis carrying it occupies (U numbering runs
 * bottom-up, so a higher `positionU` is physically nearer the top), since
 * that is what a person standing at the rack actually sees the cable head
 * toward. A chassis exactly on the midline reads by its lower (occupied) U,
 * the same "never invented, always decided" rule `snapDropToU` already
 * follows for a drop that lands exactly on a boundary.
 */
export function portalTraySide(rackHeightU: number, chassisPositionU: number): 'above' | 'below' {
  return chassisPositionU * 2 > rackHeightU ? 'above' : 'below';
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
