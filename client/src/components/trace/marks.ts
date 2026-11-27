// Where each hop's numbered mark goes on the rack canvas: a device's by its top left corner, a cable's on the
// middle of its line. Pure: the boxes come from the page (`pathBoxes.ts`).
import type { Canon } from '../checks/checksModel';
import { U_PX } from '../drawing/geometry';
import type { TraceHop } from '../../engine/engine';
import type { Point } from './pathBoxes';
import type { Box } from './pathFrame';

/** One mark: the hops it stands for, in order, and its middle in the drawing's pixels. */
export interface Spot {
  ns: number[];
  x: number;
  y: number;
}

/** A mark's height, and its width with one or two digits in it, as its style has them. */
export const MARK_SIZE = 22;
/** A mark on a device's corner sits this far up and left of it, clear of the name that starts there. */
export const MARK_OUT = 6;
/** Two marks side by side keep this much between them. */
const MARK_APART = 2;
/** One mark above another may sit this far into it. */
const MARK_LAP = 3;
/** And further where that is what it takes for two rows of a rack two units apart to share a column: a mark keeps
 * its size on the screen and the rows do not, and a third column for them would stand well clear of the rack.
 * The 3 is for a device on a shelf, which does not sit in the middle of its row. */
const ROWS_APART = 2 * U_PX - 3;

export interface MarkPlaces {
  /** Each drawn device on the path, by the id the trace knows it by. */
  devices: ReadonlyMap<string, Box>;
  /** Those of them drawn as a row of a rack, by the same id. */
  rows?: ReadonlySet<string>;
  /** The middle of each cable's line as drawn, by the cable's id. A cable drawn as two stubs has none. */
  cables: ReadonlyMap<string, Point>;
  /** Every rack. */
  racks: readonly Box[];
}

/** How many times its drawn size a mark is shown at: it keeps its size on the screen when the drawing is zoomed
 * out, so it reads at the size a framed path is shown at. */
export const markGrow = (zoom: number): number => (zoom < 1 ? 1 / zoom : 1);

/** A mark's words: its hops joined, and only those in `lit` when a trace is playing. */
export function markText(ns: readonly number[], lit: ReadonlySet<number> | null = null): string {
  return (lit == null ? ns : ns.filter((n) => lit.has(n))).join('·');
}

/** About how wide a mark is drawn at its own size: 7 a digit, 4 the dot between two hops, 5 of padding and edge
 * each side. */
export function markWidth(ns: readonly number[]): number {
  const digits = ns.reduce((sum, n) => sum + String(n).length, 0);
  return Math.max(MARK_SIZE, 10 + 7 * digits + 4 * (ns.length - 1));
}

/** The room a mark takes, in the drawing's pixels. */
export function markBox(spot: Spot, grow = 1): Box {
  const width = markWidth(spot.ns) * grow;
  const height = MARK_SIZE * grow;
  return { x: spot.x - width / 2, y: spot.y - height / 2, width, height };
}

const inside = (box: Box, p: Point): boolean => p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height;

/** What a mark numbers: a device, a spot on a cable's line, or a cable with no line of its own to carry it. */
type Target = { device: string } | { at: Point } | { from: string; to: string };

/**
 * One spot per mark, in the drawing's pixels, for every hop of a trace. Hops on the same thing share a mark
 * ("4·8"). A mark that would sit on another steps out to the left until it is clear, and each is given the room
 * of all its hops, so a mark does not move as a trace plays. `grow` is how many times its drawn size a mark is
 * shown at, so the room it needs grows with it.
 *
 * A row of a rack, and anything else drawn thinner than a mark, has its mark at its left end and level with it,
 * where it cannot be read as the row above. Any other device carries its mark on its top left corner. A cable
 * carries its mark on the middle of its line, except inside one rack, where the line is short and runs over the
 * ports it joins: there the mark goes between its two devices' marks and steps out beside the rack.
 */
export function placeMarks(hops: readonly TraceHop[], canon: Canon, places: MarkPlaces, grow = 1): Spot[] {
  const drawn = (id: string | undefined): string | null => {
    const key = id == null ? null : canon(id);
    return key != null && places.devices.has(key) ? key : null;
  };
  // What each mark numbers, and the hops that share it, the first hop's first.
  const wanted = new Map<string, { ns: number[]; target: Target }>();
  const want = (n: number, key: string, target: Target) => {
    const there = wanted.get(key);
    if (there != null) there.ns.push(n);
    else wanted.set(key, { ns: [n], target });
  };
  const onLine = (n: number, at: Point) => want(n, `at:${Math.round(at.x)},${Math.round(at.y)}`, { at });
  for (const hop of hops) {
    if (hop.kind === 'stop') continue;
    const a = drawn(hop.nodes[0]);
    // A patch panel or a splitter is a cable hop with two ports and no cable: it is marked where its device is.
    if (hop.kind !== 'cable' || hop.nodes.length < 3) {
      if (a != null) want(hop.n, `device:${a}`, { device: a });
      continue;
    }
    const b = drawn(hop.nodes[2]);
    const middle = places.cables.get(hop.nodes[1] ?? '') ?? null;
    const onRack = middle != null && places.racks.some((r) => inside(r, middle));
    if (middle != null && !onRack) onLine(hop.n, middle);
    else if (a != null && b != null) want(hop.n, `between:${[a, b].sort().join('|')}`, { from: a, to: b });
    else if (middle != null) onLine(hop.n, middle);
    else if (a != null || b != null) want(hop.n, `device:${a ?? b}`, { device: (a ?? b)! });
  }
  const half = (ns: readonly number[]) => (markWidth(ns) * grow) / 2;
  const apart = MARK_APART * grow;
  const above = Math.min((MARK_SIZE - MARK_LAP) * grow, ROWS_APART);
  const deviceSpot = (key: string, ns: readonly number[]): Point => {
    const box = places.devices.get(key)!;
    const level = places.rows?.has(key) === true || box.height < MARK_SIZE * grow;
    if (level) return { x: box.x - apart - half(ns), y: box.y + Math.min(box.height, MARK_SIZE * grow) / 2 };
    return { x: box.x - MARK_OUT * grow, y: box.y - MARK_OUT * grow };
  };
  const spotOf = (ns: readonly number[], target: Target): Point => {
    if ('device' in target) return deviceSpot(target.device, ns);
    if ('at' in target) return target.at;
    const [from, to] = [deviceSpot(target.from, ns), deviceSpot(target.to, ns)];
    return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  };
  // Then each in turn, stepping left past whatever it would sit on.
  const placed: Spot[] = [];
  for (const { ns, target } of wanted.values()) {
    const at = spotOf(ns, target);
    let x = at.x;
    for (let tries = 0; tries <= placed.length; tries += 1) {
      const hit = placed.find((o) => Math.abs(o.y - at.y) < above && Math.abs(o.x - x) < half(o.ns) + half(ns) + apart);
      if (hit == null) break;
      // A hair further than clear, so a rounding in the sum cannot leave it touching.
      x = hit.x - half(hit.ns) - half(ns) - apart - 0.01;
    }
    placed.push({ ns, x, y: at.y });
  }
  return placed;
}
