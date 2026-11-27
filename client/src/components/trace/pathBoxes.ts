// Where the page draws the things on a trace's path, read off the page itself and given in the drawing's own
// pixels. The page is asked because a device on a wall, a desk or a shelf is drawn inside another node and has no
// position of its own, and a cable's line is where its style and its sag put it.
import { cableIdsOf, type Canon } from '../checks/checksModel';
import type { Box } from './pathFrame';

/** A device drawn as a node of its own in a rack's rows. */
const ROW = '.react-flow__node-chassis';
/** Every way a device is drawn on the rack canvas: its own node, or a mark inside a shelf, wall, desk or ceiling. */
const DEVICES = `${ROW}, .react-flow__node-freeBox, [data-device-chassis]`;
/** The whole line of a cable or a bundle (the wide unseen one a click lands on). One drawn as two stubs has none. */
const LINE = '.drawing-cable:not(.drawing-cable--stub) > path[d], .drawing-bundle:not(.drawing-bundle--stub) > path[d]';

export interface Point {
  x: number;
  y: number;
}

export interface PageReader {
  /** An element's box in the drawing's pixels; null when it is not drawn. */
  box(el: Element): Box | null;
  /** A spot on the screen, in the drawing's pixels. */
  point(clientX: number, clientY: number): Point;
}

/** A trace's path as the page draws it. */
export interface PathOnPage {
  /** Each drawn device on the path, by the id the trace knows it by. One drawn twice keeps its first box. */
  devices: Map<string, Box>;
  /** Those of them drawn as a row of a rack, by the same id. */
  rows: Set<string>;
  /** Each drawn edge on the path, by the edge's id. */
  edges: Map<string, Box>;
  /** The middle of each path cable's line as drawn, by the cable's id. A cable drawn as two stubs has none. */
  cables: Map<string, Point>;
  /** Every rack. */
  racks: Box[];
}

function chassisIdOf(el: Element): string | null {
  const marked = el.getAttribute('data-device-chassis');
  if (marked != null) return marked;
  const id = el.getAttribute('data-id') ?? '';
  if (id.startsWith('chassis:')) return id.slice('chassis:'.length);
  return id.startsWith('free:') ? id.slice('free:'.length) : null;
}

/** Reads the page under `root` in the drawing's pixels, whatever the camera is doing; null with no drawing there. */
export function pageReader(root: Element): PageReader | null {
  const viewport = root.querySelector<HTMLElement>('.react-flow__viewport');
  if (viewport == null || viewport.offsetWidth === 0) return null;
  // The viewport is laid out at the pane's size and then scaled, so its two widths give the zoom, and its corner
  // is where the drawing's 0,0 is on the screen.
  const origin = viewport.getBoundingClientRect();
  const zoom = origin.width / viewport.offsetWidth;
  if (!(zoom > 0)) return null;
  const point = (clientX: number, clientY: number): Point => ({ x: (clientX - origin.left) / zoom, y: (clientY - origin.top) / zoom });
  return {
    point,
    box(el) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) return null;
      return { ...point(r.left, r.top), width: r.width / zoom, height: r.height / zoom };
    },
  };
}

/** The middle of an edge's line, along the line as drawn; null for one with no whole line. */
function middleOf(edge: Element, page: PageReader): Point | null {
  const line = edge.querySelector<SVGPathElement>(LINE);
  if (line == null || typeof line.getTotalLength !== 'function') return null;
  const length = line.getTotalLength();
  const onScreen = line.getScreenCTM();
  if (!(length > 0) || onScreen == null) return null;
  const middle = line.getPointAtLength(length / 2).matrixTransform(onScreen);
  return page.point(middle.x, middle.y);
}

/**
 * The path with `keys` on it, as the page under `root` draws it this instant. `flowEdges` are the drawing's edges
 * (a bundle stands for each cable in it).
 */
export function readPath(
  root: Element,
  page: PageReader,
  keys: ReadonlySet<string>,
  canon: Canon,
  flowEdges: readonly { id: string; data?: unknown }[],
): PathOnPage {
  const racks = Array.from(root.querySelectorAll('.react-flow__node-rack'), (el) => page.box(el)).filter((b): b is Box => b != null);
  const devices = new Map<string, Box>();
  const rows = new Set<string>();
  for (const el of root.querySelectorAll(DEVICES)) {
    const chassis = chassisIdOf(el);
    const key = chassis == null ? null : canon(chassis);
    if (key == null || !keys.has(key) || devices.has(key)) continue;
    const box = page.box(el);
    if (box == null) continue;
    devices.set(key, box);
    // A rack's row is a node of its own, lying in the rack; a device on a shelf there is drawn inside the shelf's.
    const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    if (el.matches(ROW) && racks.some((r) => middle.x >= r.x && middle.x <= r.x + r.width && middle.y >= r.y && middle.y <= r.y + r.height)) rows.add(key);
  }
  const drawn = new Map<string, Element>();
  for (const el of root.querySelectorAll('.react-flow__edge[data-id]')) drawn.set(el.getAttribute('data-id') ?? '', el);
  const edges = new Map<string, Box>();
  const cables = new Map<string, Point>();
  for (const edge of flowEdges) {
    const mine = cableIdsOf(edge).filter((c) => keys.has(c));
    const el = mine.length > 0 ? drawn.get(edge.id) : undefined;
    if (el == null) continue;
    const box = page.box(el);
    if (box != null) edges.set(edge.id, box);
    const middle = middleOf(el, page);
    if (middle != null) for (const cable of mine) if (!cables.has(cable)) cables.set(cable, middle);
  }
  return { devices, rows, edges, cables, racks };
}
