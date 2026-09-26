/**
 * The closet stop's own layout unit — `docs/decisions/adr-0050-the-rear-elevation.md`
 * §2: "the closet stop arranges racks by row, bays left to right as seen
 * from the front... the row's rear elevation reverses the bay order,
 * because you have walked round." Pure: a `RowView` (`document/view.ts`'s
 * own contract — "by bay ascending as seen from the front") and the
 * elevation the row is currently flipped to, in; the bay order to actually
 * render, left to right, and the elevation every rack in the row draws in,
 * out. No DOM, no React Flow.
 */

import type { Facing } from './elevation';
import type { RowView } from './contract';
// `SurfaceView` is ADR-0051 §1's own new shape — read straight off
// `document/view.ts`, the one place it is declared, for the same reason
// `elevation.ts`'s and `lookup.ts`'s own file headers give: `./contract.ts`
// (off limits this session) has not widened its re-export list to carry it
// yet.
import type { SurfaceView } from '../../document/view';

export interface RowLayout {
  label: string | null;
  /** The row's own flip — ADR-0050 §2: "per row at the closet stop." Every
   * rack in the row draws in this elevation; there is no per-rack override
   * at the closet stop (that is the rack stop's own control). */
  elevation: Facing;
  /** `row.racks` in the order to actually draw left to right: unchanged
   * (bay ascending) for the front elevation, reversed for the rear —
   * "because you have walked round." */
  racks: RowView['racks'];
}

export function layoutRow(row: RowView, elevation: Facing): RowLayout {
  const racks = elevation === 'rear' ? [...row.racks].reverse() : row.racks;
  return { label: row.label, elevation, racks };
}

/** A stable key for a row's own flip state, session-only like `Drawing.tsx`'s
 * other camera state — `label` when the catalogue gives the row one; the
 * index otherwise, since ADR-0050 §2 reads "a rack with no row" as its own
 * (single-rack, unlabelled) row, and two such racks must not collide on a
 * shared `null` key. */
export function rowKey(row: Pick<RowView, 'label'>, index: number): string {
  return row.label ?? `__row-${index}__`;
}

/** s6f #3: a dragged rack's own mirrored x when its row flips — "the rack a
 * person dragged in that row moves by the mirror of its dragged offset, not
 * to a fresh slot." Reflects `x` across the row's own width (the same span
 * `rackCount` racks laid out `rackWidthPx` wide with `gapPx` between them
 * occupy), rather than reassigning it to whatever bay index it now falls
 * at. For a rack that already sat exactly on a bay slot this lands on the
 * same x the ordinary `bayIndex * (rackWidthPx + gapPx)` formula would give
 * it for the reversed bay order — the two are the same reflection, one
 * generalised to an x a drag left off any slot, the other assuming one. */
/** Session-only gap between racks placed side by side — never a document
 * fact, never saved (layout is remembered in component state only for the
 * session; persisting it is `OPEN-QUESTIONS` D5). */
export const RACK_GAP_PX = 96;

/** Vertical gap between one row's band and the next — the same kind of
 * session choice `RACK_GAP_PX` above is. */
export const ROW_GAP_PX = 64;

export function mirroredRackX(x: number, rackCount: number, rackWidthPx: number, gapPx: number): number {
  if (rackCount <= 0) return x;
  const rowWidth = (rackCount - 1) * (rackWidthPx + gapPx) + rackWidthPx;
  return rowWidth - rackWidthPx - x;
}

/** The flow-space top of the `rowIndex`-th row's band — every row stacked
 * top to bottom, each band as tall as its tallest rack. */
export function rowBandY(rowLayouts: readonly RowLayout[], rowIndex: number, rackHeight: (rack: RowLayout['racks'][number]) => number, gapPx: number): number {
  let y = 0;
  for (let i = 0; i < rowIndex; i += 1) {
    const heights = rowLayouts[i]!.racks.map(rackHeight);
    y += Math.max(0, ...heights) + gapPx;
  }
  return y;
}

/* ---- surfaces, after the rows — ADR-0051 §1/§2,
   `design/places/renders/Surfaces.png` ---------------------------------- */

/** `design/places/renders/Surfaces.png` (ADR-0051 §1/§2) — a surface's own
 * millimetre facts scale from the rack's own height, 44.45 mm per U: one U
 * is 44.45mm (the EIA-310 unit the whole industry rack is
 * built to), the SAME ruler a rack elevation already draws by. `U_PX`
 * (`geometry.ts`) is how many flow pixels this drawing gives one U at the
 * rack stop; together the two fix the one conversion a surface's own
 * millimetre facts (`FixedTo.x_mm`/`.y_mm`, `Surface.width_mm`/`.height_mm`)
 * need to draw beside a rack elevation at the same scale, never a second,
 * independently-chosen one — a metre of wall and a metre of rack read the
 * same number of flow pixels. */
export const MM_PER_U = 44.45;

/** Flow pixels per millimetre, at whatever `uPx` a caller's rack elevation
 * is currently drawing at (`geometry.ts`'s `U_PX`, handed in rather than
 * imported — see the file header on why this module stays parameterised,
 * plain-number pixel arithmetic throughout). */
export function pxPerMm(uPx: number): number {
  return uPx / MM_PER_U;
}

export function mmToPx(mm: number, uPx: number): number {
  return mm * pxPerMm(uPx);
}

/** One surface, placed in flow space — `SurfaceNode.tsx`'s own input, the
 * box it draws inside. */
export interface SurfacePlacement {
  surface: SurfaceView;
  x: number;
  y: number;
  widthPx: number;
  heightPx: number;
}

export interface SurfacesLayout {
  /** Every non-floor surface (wall, desk, ceiling), stacked top to bottom —
   * `design/places/renders/Surfaces.png` (ADR-0051 §1/§2): walls draw to
   * the right of their premises' rows. One `ClosetView` is one premises'
   * worth of rows, so "to the right" resolves to exactly one column, never
   * a per-row choice. */
  panels: SurfacePlacement[];
  /** The one `form: 'floor'` surface this closet draws, spanning beneath
   * both the rows and the panels above — `null` when this view carries
   * none. More than one `form: 'floor'` surface is not a shape the boards
   * draw (one closet, one floor); the first is what this drawing shows. */
  floor: SurfacePlacement | null;
}

/** Session default for a panel's own width when `Surface.width_mm` has not
 * been measured yet (`FixedTo`'s own schema doc: a position — and here, by
 * the same reasoning, a surface's own extent — may simply not be measured)
 * — wide enough to hold a board and a few fixtures at the Surfaces board's
 * own scale without a caller having measured anything, the same kind of
 * session choice `RACK_GAP_PX` (`Drawing.tsx`) already is. */
export const DEFAULT_PANEL_WIDTH_PX = 340;

/** The floor band's own flow-space height — `design/places/renders/Surfaces.png`
 * (ADR-0051 §1/§2): the floor draws as a band beneath the row's racks,
 * never an elevation of its own (it has no millimetre rail — a floor
 * fixture's `yMm`, when it even carries one, is not "height on the floor,"
 * `SurfaceNode.tsx`'s own file header). A session constant, tall enough for
 * an upright fixture box to read as standing on it. */
export const FLOOR_BAND_HEIGHT_PX = 120;

/** Gap between one surface panel and the next, and between the row block
 * (or the panels) and the floor band beneath — the same kind of session
 * choice `Drawing.tsx`'s own `ROW_GAP_PX` is, reused here so the closet
 * stop's rhythm (rows, then surfaces) does not introduce a second, visibly
 * different spacing unit. */
export const SURFACE_GAP_PX = 64;

/**
 * ADR-0051 §1 / `design/places/renders/Surfaces.png`: the closet layout
 * places surfaces after the rows, walls to the right of their premises'
 * rows and the floor beneath. Pure pixel arithmetic, like `mirroredRackX` above:
 * `rowsWidthPx`/`rowsHeightPx` are the row block's own total footprint,
 * already computed by the caller (`Drawing.tsx`'s own `rowLayouts`) from
 * each row's rack COUNT and HEIGHT — never from which order the racks
 * within a row currently draw in. A row's own flip (`layoutRow` above)
 * reorders `RowLayout.racks` but changes neither the count nor any rack's
 * own height, so `rowsWidthPx`/`rowsHeightPx` — and therefore everything
 * this function returns — are unchanged by a flip: "positions stable across
 * flips" is then simply true by construction, the same way it is for
 * `mirroredRackX`'s own reflection.
 *
 * `panelHeightPx` is every non-floor surface's own drawn height — drawn at
 * the height of a rack (`design/places/renders/Surfaces.png`, ADR-0051
 * §1/§2) — one session constant every wall/desk/ceiling shares (a caller's
 * own choice of which rack's height
 * that is; `Drawing.tsx` reads it off the tallest rack this closet holds),
 * never read off `SurfaceView.heightMm` — that stays a fact used instead to
 * scale a panel's OWN fixtures once it is drawn this tall
 * (`SurfaceNode.tsx`'s own job). `uPx` is `geometry.ts`'s own `U_PX`, handed
 * in for the same "stay plain pixel arithmetic" reason every other
 * pixel-shaped parameter in this module is (`mirroredRackX`'s own
 * `rackWidthPx`) — only reached when a panel actually carries a
 * `Surface.width_mm` (`mmToPx`, above); `DEFAULT_PANEL_WIDTH_PX` covers
 * every panel that does not.
 */
export function layoutSurfaces(
  surfaces: readonly SurfaceView[],
  rowsWidthPx: number,
  rowsHeightPx: number,
  panelHeightPx: number,
  uPx: number,
  gapPx: number = SURFACE_GAP_PX,
): SurfacesLayout {
  const panelSurfaces = surfaces.filter((s) => s.form !== 'floor');
  const floorSurfaces = surfaces.filter((s) => s.form === 'floor');

  const panelX = rowsWidthPx + gapPx;
  const panels: SurfacePlacement[] = [];
  let y = 0;
  for (const surface of panelSurfaces) {
    const widthPx = surface.widthMm != null ? mmToPx(surface.widthMm, uPx) : DEFAULT_PANEL_WIDTH_PX;
    panels.push({ surface, x: panelX, y, widthPx, heightPx: panelHeightPx });
    y += panelHeightPx + gapPx;
  }

  const panelsRight = panels.length > 0 ? Math.max(...panels.map((p) => p.x + p.widthPx)) : rowsWidthPx;
  const panelsBottom = panels.length > 0 ? y - gapPx : 0;
  const floorWidth = Math.max(rowsWidthPx, panelsRight);
  const floorY = Math.max(rowsHeightPx, panelsBottom) + gapPx;

  const floor: SurfacePlacement | null =
    floorSurfaces.length > 0
      ? { surface: floorSurfaces[0]!, x: 0, y: floorY, widthPx: floorWidth, heightPx: FLOOR_BAND_HEIGHT_PX }
      : null;

  return { panels, floor };
}

/** `SurfaceNode.tsx`'s own millimetre rail — a millimetre rail at its left,
 * positions in mm from the floor (`design/places/renders/Surfaces.png`'s
 * own `1800/1500/.../0` ticks, ADR-0051 §1/§2).
 * Pure: every tick, 0mm (the floor) upward in `stepMm` steps, up to
 * whatever `heightPx` (a panel's own elevation body height) actually
 * covers at this scale — never a tick beyond what the panel can draw.
 * `stepMm` defaults to the boards' own 300mm rhythm. */
export function mmRailTicks(heightPx: number, uPx: number, stepMm: number = 300): number[] {
  if (heightPx <= 0 || uPx <= 0) return [0];
  const totalMm = heightPx / pxPerMm(uPx);
  const ticks: number[] = [];
  for (let mm = 0; mm <= totalMm + 1e-6; mm += stepMm) ticks.push(Math.round(mm));
  return ticks;
}
