/** The Diagram look (ADR-0061 round 7): every rack chassis is a plain labelled
 * box, one column per rack, and every cable is a square-cornered line between
 * boxes. Pure: the view in, boxes and paths out. */

import type { CableView, ClosetView } from "./contract";
import type { FixtureView } from "../../document/view";

export const BOX_W = 200;
export const BOX_H = 64;
export const COLUMN_PITCH = 420;
export const ROW_PITCH = 150;
/** Parallel cables between one pair sit this far apart. */
export const LANE_PX = 8;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DiagramBox extends Rect {
  id: string;
  hostname: string;
  rackLabel: string | null;
  role: string | null;
}

const FORM_ORDER = ["wall", "floor", "desk", "ceiling"];

/** Fixtures top to bottom, then left to right, as they hang on their surface; one not measured yet goes last. */
function byPlace(a: FixtureView, b: FixtureView): number {
  const at = (v: number | null) => v ?? Number.POSITIVE_INFINITY;
  return at(a.yMm) - at(b.yMm) || at(a.xMm) - at(b.xMm) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}

/** Every device in the view, in columns: one per rack (racked devices from the top unit down, then what sits
 * on its shelves), one per wall, floor or desk, then one for devices on free canvas spots or not placed at
 * all. A device is drawn once, and passives (a panel, a splitter, an outlet block) are not devices. */
export function layoutDiagram(view: ClosetView): DiagramBox[] {
  const boxes: DiagramBox[] = [];
  const seen = new Set<string>();
  let col = 0;
  const column = (
    label: string | null,
    devices: Array<{ id: string; hostname: string; role: string | null }>,
  ) => {
    const fresh: typeof devices = [];
    for (const d of devices)
      if (!seen.has(d.id)) {
        seen.add(d.id);
        fresh.push(d);
      }
    fresh.forEach((d, row) => {
      boxes.push({
        id: d.id,
        hostname: d.hostname,
        rackLabel: label,
        role: d.role,
        x: col * COLUMN_PITCH,
        y: row * ROW_PITCH,
        w: BOX_W,
        h: BOX_H,
      });
    });
    if (fresh.length > 0) col += 1;
  };
  for (const rack of view.racks) {
    const ordered = [...rack.chassis].sort(
      (a, b) => b.positionU - a.positionU || a.id.localeCompare(b.id),
    );
    const onShelves = (rack.shelves ?? []).flatMap((s) =>
      s.occupants
        .filter((o) => o.kind === "chassis")
        .map((o) => ({
          id: o.id,
          hostname: o.chassis?.hostname ?? o.label,
          role: o.chassis?.role ?? null,
        })),
    );
    column(rack.label, [
      ...ordered.map((c) => ({
        id: c.id,
        hostname: c.hostname,
        role: c.role ?? null,
      })),
      ...onShelves,
    ]);
  }
  const fixtures = (
    list: FixtureView[],
  ): Array<{ id: string; hostname: string; role: string | null }> =>
    [...list].sort(byPlace).flatMap((f) => [
      ...(f.kind === "chassis"
        ? [
            {
              id: f.id,
              hostname: f.chassis?.hostname ?? f.label,
              role: f.chassis?.role ?? null,
            },
          ]
        : []),
      ...fixtures(f.fixtures ?? []),
    ]);
  // A fixed order, so Diagram looks the same on every load: walls, floors, desks, then ceilings, each by name.
  const surfaces = [...(view.surfaces ?? [])].sort(
    (a, b) => FORM_ORDER.indexOf(a.form) - FORM_ORDER.indexOf(b.form) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
  );
  for (const surface of surfaces)
    column(surface.label, fixtures(surface.fixtures ?? []));
  column(
    null,
    [...(view.free ?? []), ...(view.unplaced ?? [])].map((d) => ({
      id: d.id,
      hostname: d.hostname,
      role: d.role ?? null,
    })),
  );
  return boxes;
}

export interface Route {
  d: string;
  /** Where the line meets each box, and the unit direction it leaves along. */
  a: { x: number; y: number; dx: number; dy: number };
  b: { x: number; y: number; dx: number; dy: number };
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/** A square-cornered route from `ra` to `rb`: straight when the boxes overlap
 * on an axis, otherwise out sideways, across and in. `lane` shifts it off the
 * centre so cables between the same pair do not lie on one another. */
export function orthRoute(ra: Rect, rb: Rect, lane = 0): Route {
  const ox0 = Math.max(ra.x, rb.x);
  const ox1 = Math.min(ra.x + ra.w, rb.x + rb.w);
  if (ox1 - ox0 > 8) {
    const x = clamp((ox0 + ox1) / 2 + lane, ox0 + 4, ox1 - 4);
    const down = ra.y < rb.y;
    const ya = down ? ra.y + ra.h : ra.y;
    const yb = down ? rb.y : rb.y + rb.h;
    const s = down ? 1 : -1;
    return {
      d: `M ${x} ${ya} L ${x} ${yb}`,
      a: { x, y: ya, dx: 0, dy: s },
      b: { x, y: yb, dx: 0, dy: -s },
    };
  }
  const oy0 = Math.max(ra.y, rb.y);
  const oy1 = Math.min(ra.y + ra.h, rb.y + rb.h);
  if (oy1 - oy0 > 8) {
    const y = clamp((oy0 + oy1) / 2 + lane, oy0 + 4, oy1 - 4);
    const right = ra.x < rb.x;
    const xa = right ? ra.x + ra.w : ra.x;
    const xb = right ? rb.x : rb.x + rb.w;
    const s = right ? 1 : -1;
    return {
      d: `M ${xa} ${y} L ${xb} ${y}`,
      a: { x: xa, y, dx: s, dy: 0 },
      b: { x: xb, y, dx: -s, dy: 0 },
    };
  }
  const right = ra.x < rb.x;
  const xa = right ? ra.x + ra.w : ra.x;
  const xb = right ? rb.x : rb.x + rb.w;
  const ya = ra.y + ra.h / 2 + lane;
  const yb = rb.y + rb.h / 2 + lane;
  const mid = (xa + xb) / 2 + lane;
  const s = right ? 1 : -1;
  return {
    d: `M ${xa} ${ya} L ${mid} ${ya} L ${mid} ${yb} L ${xb} ${yb}`,
    a: { x: xa, y: ya, dx: s, dy: 0 },
    b: { x: xb, y: yb, dx: -s, dy: 0 },
  };
}

export interface DiagramLine {
  cable: CableView;
  a: string;
  b: string;
  /** Slot among the cables joining the same two boxes, centred on zero. */
  lane: number;
}

/** One line per cable with both ends on drawn boxes; a loop back to its own box is not drawn. */
export function diagramLines(
  view: ClosetView,
  boxIds: ReadonlySet<string>,
): DiagramLine[] {
  const pairs = new Map<string, CableView[]>();
  const ends = new Map<string, [string, string]>();
  for (const cable of view.cables) {
    const real = cable.ends.filter(
      (e): e is { portId: string; chassisId: string; rackId: string | null } =>
        "portId" in e,
    );
    if (real.length !== 2) continue;
    const [a, b] = [real[0]!.chassisId, real[1]!.chassisId];
    if (a === b || !boxIds.has(a) || !boxIds.has(b)) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    pairs.set(key, [...(pairs.get(key) ?? []), cable]);
    ends.set(cable.id, [a, b]);
  }
  const out: DiagramLine[] = [];
  for (const cables of pairs.values()) {
    cables.forEach((cable, i) => {
      const [a, b] = ends.get(cable.id)!;
      out.push({ cable, a, b, lane: (i - (cables.length - 1) / 2) * LANE_PX });
    });
  }
  return out;
}
