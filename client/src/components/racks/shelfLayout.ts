// Sign-off shelf-view: where each thing on a shelf is drawn, in millimetres from the shelf's
// inside left edge (x) and back from its front lip (y). Pure, so the drag and the tests share one rule.
import type { OccupantView, PortView } from '../../document/view';

/** A 19-inch rack's opening between the rails (EIA-310: 450 mm), which is what a shelf's tray
 * spans. Neither the rack nor the shelf records its own width yet, so every shelf draws at this. */
export const SHELF_INSIDE_MM = 450;
/** How deep a shelf is drawn from its front lip back. A shelf records no depth yet; 300 mm is a
 * common 1U cantilever shelf, and a thing set back further is drawn hanging off its back. */
export const SHELF_DEPTH_MM = 300;
/** The gap left between two things laid out by slot, before anyone has placed them by hand. */
const AUTO_GAP_MM = 6;
/** The step a drop snaps to, and how near a neighbour's edge pulls a drop flush against it. */
export const SNAP_STEP_MM = 10;
const SNAP_EDGE_MM = 8;

export type ShelfFace = 'front' | 'rear';

export interface ShelfItem {
  id: string;
  xMm: number;
  /** Back from the front lip to its front face; 0 when pushed to the front. */
  yMm: number;
  wMm: number;
  hMm: number;
  dMm: number;
  /** True when the size is the catalogue's (the maker's sheet); false when estimated from its ports. */
  sized: boolean;
  /** True when `xMm` is the document's own (`SitsOn.x_mm`); false when laid out here by slot. */
  placed: boolean;
  /** True when it could not be fitted inside the shelf and is drawn past its right end. */
  over: boolean;
}

type Box = Pick<ShelfItem, 'xMm' | 'wMm' | 'yMm' | 'dMm'>;

/** The ports drawn on one face of an occupant. Side and top ports are on neither. */
export function portsOnFace(occupant: Pick<OccupantView, 'ports'>, face: ShelfFace): PortView[] {
  return occupant.ports.filter((p) => p.face === face);
}

/** When the catalogue records no size, a thing's box is a guess from its ports (about 14 mm a
 * port, which is an RJ45's pitch on a desktop switch), drawn with a dashed edge. Its depth is
 * guessed as most of its width, the shape of a small desktop box. */
export function estimateSizeMm(occupant: Pick<OccupantView, 'ports' | 'kind'>): { wMm: number; hMm: number; dMm: number } {
  const n = Math.max(portsOnFace(occupant, 'front').length, portsOnFace(occupant, 'rear').length);
  if (n === 0) {
    const wMm = occupant.kind === 'passive' ? 140 : 110;
    return { wMm, hMm: 40, dMm: Math.round(wMm * 0.8) };
  }
  const rows = n > 24 ? 2 : 1;
  const wMm = Math.min(440, Math.max(70, 28 + Math.ceil(n / rows) * 14));
  const hMm = rows === 2 ? 44 : n <= 2 ? 50 : 32;
  return { wMm, hMm, dMm: Math.min(SHELF_DEPTH_MM - 20, Math.max(60, Math.round(wMm * 0.75))) };
}

/** The catalogue's size when it records one, otherwise the estimate. */
export function sizeOf(occupant: Pick<OccupantView, 'ports' | 'kind' | 'sizeMm'>): { wMm: number; hMm: number; dMm: number; sized: boolean } {
  const s = occupant.sizeMm;
  if (s != null) return { wMm: s.widthMm, hMm: s.heightMm, dMm: s.depthMm, sized: true };
  return { ...estimateSizeMm(occupant), sized: false };
}

/** True when two footprints share any depth: only then does one stop the other sliding along. */
function sameRow(a: Pick<Box, 'yMm' | 'dMm'>, b: Pick<Box, 'yMm' | 'dMm'>): boolean {
  return a.yMm < b.yMm + b.dMm && b.yMm < a.yMm + a.dMm;
}

/** Every occupant's box: those placed by hand where they were put, the rest packed left to right
 * by slot along the front into the space left, each in the first gap it fits. */
export function layoutShelf(occupants: readonly OccupantView[], insideMm: number = SHELF_INSIDE_MM): ShelfItem[] {
  const out = new Map<string, ShelfItem>();
  const placedBoxes: Box[] = [];
  for (const o of occupants) {
    if (o.xMm == null) continue;
    const size = sizeOf(o);
    const yMm = o.yMm ?? 0;
    out.set(o.id, { id: o.id, xMm: o.xMm, yMm, ...size, placed: true, over: o.xMm + size.wMm > insideMm });
    placedBoxes.push({ xMm: o.xMm, wMm: size.wMm, yMm, dMm: size.dMm });
  }
  let overflowAt = Math.max(insideMm, ...placedBoxes.map((b) => b.xMm + b.wMm)) + AUTO_GAP_MM;
  const taken: Box[] = [...placedBoxes];
  for (const o of [...occupants].filter((o) => o.xMm == null).sort((a, b) => a.slot - b.slot)) {
    const size = sizeOf(o);
    const row = taken.filter((t) => sameRow(t, { yMm: 0, dMm: size.dMm })).map((t): [number, number] => [t.xMm, t.xMm + t.wMm]);
    const x = firstFit(row, size.wMm, insideMm);
    if (x == null) {
      out.set(o.id, { id: o.id, xMm: overflowAt, yMm: 0, ...size, placed: false, over: true });
      overflowAt += size.wMm + AUTO_GAP_MM;
    } else {
      out.set(o.id, { id: o.id, xMm: x, yMm: 0, ...size, placed: false, over: false });
      taken.push({ xMm: x, wMm: size.wMm, yMm: 0, dMm: size.dMm });
    }
  }
  return occupants.map((o) => out.get(o.id)!);
}

function firstFit(taken: ReadonlyArray<[number, number]>, w: number, insideMm: number): number | null {
  const sorted = [...taken].sort((a, b) => a[0] - b[0]);
  let x = 0;
  for (const [a, b] of sorted) {
    if (a - x >= w) return x;
    x = Math.max(x, b + AUTO_GAP_MM);
  }
  return insideMm - x >= w ? x : null;
}

/**
 * Where a box `wMm` wide lands when dropped with its left side at `wantX`, among `others`:
 * snapped to `SNAP_STEP_MM` and flush against a neighbour within `SNAP_EDGE_MM` when `snap`,
 * never overlapping another thing nor past either end. Moves it to the nearest gap it fits when
 * the spot asked for is taken, and is `null` when it fits nowhere. `others` are the things in its
 * row; ones set further back or further forward do not block it (see `dropOnPlan`).
 */
export function dropSpot(
  others: ReadonlyArray<Pick<ShelfItem, 'xMm' | 'wMm'>>,
  wMm: number,
  wantX: number,
  snap: boolean,
  insideMm: number = SHELF_INSIDE_MM,
): number | null {
  const max = insideMm - wMm;
  if (max < 0) return null;
  let x = Math.min(max, Math.max(0, wantX));
  if (snap) {
    let best: number | null = null;
    for (const o of others) {
      for (const edge of [o.xMm + o.wMm, o.xMm - wMm]) {
        if (Math.abs(edge - x) <= SNAP_EDGE_MM && (best == null || Math.abs(edge - x) < Math.abs(best - x))) best = edge;
      }
    }
    for (const edge of [0, max]) if (Math.abs(edge - x) <= SNAP_EDGE_MM && best == null) best = edge;
    x = best ?? Math.round(x / SNAP_STEP_MM) * SNAP_STEP_MM;
    x = Math.min(max, Math.max(0, x));
  }
  const clashes = (at: number) => others.some((o) => at < o.xMm + o.wMm && o.xMm < at + wMm);
  if (!clashes(x)) return x;
  // The nearest spot in any gap wide enough.
  const sorted = [...others].sort((a, b) => a.xMm - b.xMm);
  const gaps: Array<[number, number]> = [];
  let from = 0;
  for (const o of sorted) {
    if (o.xMm - from >= wMm) gaps.push([from, o.xMm - wMm]);
    from = Math.max(from, o.xMm + o.wMm);
  }
  if (insideMm - from >= wMm) gaps.push([from, max]);
  let pick: number | null = null;
  for (const [lo, hi] of gaps) {
    const at = Math.min(hi, Math.max(lo, x));
    if (pick == null || Math.abs(at - x) < Math.abs(pick - x)) pick = at;
  }
  return pick;
}

/** How far back a box `dMm` deep can go: snapped to the front, the back and 10 mm steps when `snap`,
 * and never past the back edge (a box deeper than the shelf stays at the front). */
export function depthSpot(dMm: number, wantY: number, snap: boolean, depthMm: number = SHELF_DEPTH_MM): number {
  const max = Math.max(0, depthMm - dMm);
  let y = Math.min(max, Math.max(0, wantY));
  if (snap) {
    if (y <= SNAP_EDGE_MM) y = 0;
    else if (max - y <= SNAP_EDGE_MM) y = max;
    else y = Math.min(max, Math.round(y / SNAP_STEP_MM) * SNAP_STEP_MM);
  }
  return y;
}

/**
 * Where a box lands when dragged in the strip seen from above to `wantX`, `wantY`: the depth first
 * (`depthSpot`), then along the shelf among only the things it shares depth with (`dropSpot`), so
 * two things can sit one behind the other but never overlap. `null` when it fits nowhere in that row.
 */
export function dropOnPlan(
  others: readonly Box[],
  box: Pick<Box, 'wMm' | 'dMm'>,
  wantX: number,
  wantY: number,
  snap: boolean,
  insideMm: number = SHELF_INSIDE_MM,
  depthMm: number = SHELF_DEPTH_MM,
): { xMm: number; yMm: number } | null {
  const yMm = depthSpot(box.dMm, wantY, snap, depthMm);
  const row = others.filter((o) => sameRow(o, { yMm, dMm: box.dMm }));
  const xMm = dropSpot(row, box.wMm, wantX, snap, insideMm);
  return xMm == null ? null : { xMm, yMm };
}

/** The things in the same row as `box` (sharing any depth), the ones a slide along the shelf stops against. */
export function rowOf<T extends Box>(others: readonly T[], box: Pick<Box, 'yMm' | 'dMm'>): T[] {
  return others.filter((o) => sameRow(o, box));
}
