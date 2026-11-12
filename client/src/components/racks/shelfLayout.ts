// Sign-off shelf-view: where each thing on a shelf is drawn, in millimetres from the shelf's
// inside left edge. Pure, so the drag and the tests share one rule.
import type { OccupantView, PortView } from '../../document/view';

/** A 19-inch rack's opening between the rails (EIA-310: 450 mm), which is what a shelf's tray
 * spans. Neither the rack nor the shelf records its own width yet, so every shelf draws at this. */
export const SHELF_INSIDE_MM = 450;
/** The gap left between two things laid out by slot, before anyone has placed them by hand. */
const AUTO_GAP_MM = 6;
/** The step a drop snaps to, and how near a neighbour's edge pulls a drop flush against it. */
export const SNAP_STEP_MM = 10;
const SNAP_EDGE_MM = 8;

export type ShelfFace = 'front' | 'rear';

export interface ShelfItem {
  id: string;
  xMm: number;
  wMm: number;
  hMm: number;
  /** True when `xMm` is the document's own (`SitsOn.x_mm`); false when laid out here by slot. */
  placed: boolean;
  /** True when it could not be fitted inside the shelf and is drawn past its right end. */
  over: boolean;
}

/** The ports drawn on one face of an occupant. Side and top ports are on neither. */
export function portsOnFace(occupant: Pick<OccupantView, 'ports'>, face: ShelfFace): PortView[] {
  return occupant.ports.filter((p) => p.face === face);
}

/** No model in the catalogue records a size yet, so a thing's box is a guess from its ports
 * (about 14 mm a port, which is an RJ45's pitch on a desktop switch), drawn with a dashed edge. */
export function estimateSizeMm(occupant: Pick<OccupantView, 'ports' | 'kind'>): { wMm: number; hMm: number } {
  const n = Math.max(portsOnFace(occupant, 'front').length, portsOnFace(occupant, 'rear').length);
  if (n === 0) return { wMm: occupant.kind === 'passive' ? 140 : 110, hMm: 40 };
  const rows = n > 24 ? 2 : 1;
  const wMm = Math.min(440, Math.max(70, 28 + Math.ceil(n / rows) * 14));
  const hMm = rows === 2 ? 44 : n <= 2 ? 50 : 32;
  return { wMm, hMm };
}

/** Every occupant's box: those placed by hand where they were put, the rest packed left to right
 * by slot into the space left, each in the first gap it fits. */
export function layoutShelf(occupants: readonly OccupantView[], insideMm: number = SHELF_INSIDE_MM): ShelfItem[] {
  const out = new Map<string, ShelfItem>();
  const taken: Array<[number, number]> = [];
  for (const o of occupants) {
    if (o.xMm == null) continue;
    const size = estimateSizeMm(o);
    out.set(o.id, { id: o.id, xMm: o.xMm, ...size, placed: true, over: o.xMm + size.wMm > insideMm });
    taken.push([o.xMm, o.xMm + size.wMm]);
  }
  let overflowAt = Math.max(insideMm, ...taken.map(([, b]) => b)) + AUTO_GAP_MM;
  for (const o of [...occupants].filter((o) => o.xMm == null).sort((a, b) => a.slot - b.slot)) {
    const size = estimateSizeMm(o);
    const x = firstFit(taken, size.wMm, insideMm);
    if (x == null) {
      out.set(o.id, { id: o.id, xMm: overflowAt, ...size, placed: false, over: true });
      overflowAt += size.wMm + AUTO_GAP_MM;
    } else {
      out.set(o.id, { id: o.id, xMm: x, ...size, placed: false, over: false });
      taken.push([x, x + size.wMm]);
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
 * the spot asked for is taken, and is `null` when it fits nowhere.
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
