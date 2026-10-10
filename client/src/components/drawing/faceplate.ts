/** Where each port sits on a plate, and where the device's name goes. Pure:
 * ports in, flow-space boxes out, so the plate, the cables and the details
 * panel all read the same layout. */

import { GLYPH_SIZE, type PortKind } from '../ports';
import type { InletView, PortView } from './contract';
import type { Facing } from './elevation';
import { RACK_INNER_PX, U_PX } from './geometry';
import { portKindFor } from './portGlyph';

const PAD_X = 4;
const PAD_Y = 1.5;
const GROUP_GAP = 6;
const CELL_GAP = 1.5;
const MAX_SCALE = 0.75;
/** Rough width of one bold 9px character. */
const NAME_CHAR_PX = 5.4;
const NAME_MIN_FREE = 28;
const BAND_PX = 11;

export interface PortBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: PortKind;
  /** 0 top, 1 bottom, -1 a single port centred between the two rows. */
  row: number;
}

export type NameSpot =
  | { mode: 'inline'; x: number; y: number; w: number }
  | { mode: 'band'; x: number; y: number; w: number }
  | { mode: 'tab' };

export interface FaceplateLayout {
  boxes: PortBox[];
  byId: ReadonlyMap<string, PortBox>;
  /** Flow px per true glyph px. */
  scale: number;
  name: NameSpot;
}

function natural(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

interface Cell {
  port: PortView;
  kind: PortKind;
  row: number;
  col: number;
  gap: boolean;
}

/** Ports with no catalogue position (typed by hand) are flowed: numbered, two
 * rows when there are more than twelve, one cluster per connector. */
function flowed(ports: PortView[], kinds: Map<string, PortKind>): Cell[] {
  const sorted = [...ports].sort((a, b) => natural(a.label, b.label));
  const rows = sorted.length > 12 ? 2 : 1;
  const groups = new Map<PortKind, PortView[]>();
  for (const p of sorted) {
    const k = kinds.get(p.id)!;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const cells: Cell[] = [];
  let col = 0;
  let first = true;
  for (const [kind, members] of [...groups].sort((a, b) => GLYPH_SIZE[a[0]].w - GLYPH_SIZE[b[0]].w)) {
    members.forEach((port, i) => {
      cells.push({ port, kind, row: rows === 2 ? i % 2 : -1, col: col + Math.floor(i / rows), gap: !first && i === 0 });
    });
    col += Math.ceil(members.length / rows);
    first = false;
  }
  return cells;
}

function positioned(ports: PortView[], kinds: Map<string, PortKind>): Cell[] {
  return ports.map((port) => ({
    port,
    kind: kinds.get(port.id)!,
    row: port.rowKind === 'single' ? -1 : port.row,
    col: port.column,
    gap: port.gapBefore === true,
  }));
}

/** A plate coordinate's span: thousandths of the plate (schema 0.19, `PhysicalPort.plate_x`). */
export const PLATE_SPAN = 1000;

/** Top-left of a `w`×`h` port whose centre is stored at `plate`, kept wholly on a plate `plateH` tall. */
export function plateBoxAt(plate: { x: number; y: number }, w: number, h: number, plateH: number, plateW: number = RACK_INNER_PX): { x: number; y: number } {
  const cx = (plate.x / PLATE_SPAN) * plateW;
  const cy = (plate.y / PLATE_SPAN) * plateH;
  return { x: Math.max(0, Math.min(plateW - w, cx - w / 2)), y: Math.max(0, Math.min(plateH - h, cy - h / 2)) };
}

export function layoutFaceplate(ports: readonly PortView[], heightU: number, name: string): FaceplateLayout {
  const kinds = new Map<string, PortKind>();
  const drawable: PortView[] = [];
  for (const p of ports) {
    const k = portKindFor(p.connector);
    if (k == null) continue;
    kinds.set(p.id, k);
    drawable.push(p);
  }
  const plateH = heightU * U_PX;
  const nameW = name.length * NAME_CHAR_PX + 6;
  if (drawable.length === 0) {
    return { boxes: [], byId: new Map(), scale: 1, name: nameW <= RACK_INNER_PX - 2 * PAD_X ? { mode: 'inline', x: PAD_X, y: 0, w: RACK_INNER_PX - 2 * PAD_X } : { mode: 'tab' } };
  }
  const placed = drawable.some((p) => p.row !== drawable[0]!.row || p.column !== drawable[0]!.column);
  const cells = placed ? positioned(drawable, kinds) : flowed(drawable, kinds);

  // One column slot per distinct column index, as wide as its widest glyph.
  const cols = [...new Set(cells.map((c) => c.col))].sort((a, b) => a - b);
  const colTrue = new Map<number, number>();
  const colGap = new Map<number, boolean>();
  for (const c of cells) {
    colTrue.set(c.col, Math.max(colTrue.get(c.col) ?? 0, GLYPH_SIZE[c.kind].w));
    if (c.gap) colGap.set(c.col, true);
  }
  const twoRows = cells.some((c) => c.row >= 0);
  const rowCount = twoRows ? 2 : 1;
  const maxTrueH = Math.max(...cells.map((c) => GLYPH_SIZE[c.kind].h));
  const trueW = cols.reduce((n, c) => n + colTrue.get(c)!, 0);
  const fixed = cols.length * CELL_GAP + [...colGap.values()].length * GROUP_GAP;
  const availW = RACK_INNER_PX - 2 * PAD_X;
  const availH = plateH - 2 * PAD_Y;
  const sH = (availH - (rowCount - 1) * CELL_GAP) / rowCount / maxTrueH;
  const sW = (availW - fixed) / trueW;
  const scale = Math.max(0.05, Math.min(sH, sW, MAX_SCALE));

  const colX = new Map<number, number>();
  let x = 0;
  for (const c of cols) {
    if (colGap.get(c)) x += GROUP_GAP;
    colX.set(c, x);
    x += colTrue.get(c)! * scale + CELL_GAP;
  }
  const blockW = x - CELL_GAP;
  const left = RACK_INNER_PX - PAD_X - blockW;
  const rowH = maxTrueH * scale;
  const blockH = rowCount * rowH + (rowCount - 1) * CELL_GAP;
  const top = (plateH - blockH) / 2;

  const boxes: PortBox[] = cells.map((c) => {
    const size = GLYPH_SIZE[c.kind];
    const w = size.w * scale;
    const h = size.h * scale;
    const slotW = colTrue.get(c.col)! * scale;
    const rowTop = c.row === 1 ? top + rowH + CELL_GAP : top;
    const slotH = c.row === -1 ? blockH : rowH;
    const plate = c.port.plate;
    // Schema 0.19: a hand-typed port someone dragged sits where they put it, kept on the plate.
    if (plate != null && c.port.rowKind === undefined) {
      const at = plateBoxAt(plate, w, h, plateH);
      return { id: c.port.id, x: at.x, y: at.y, w, h, kind: c.kind, row: c.row };
    }
    return { id: c.port.id, x: left + colX.get(c.col)! + (slotW - w) / 2, y: (c.row === -1 ? top : rowTop) + (slotH - h) / 2, w, h, kind: c.kind, row: c.row };
  });

  const placedAny = cells.some((c) => c.port.plate != null && c.port.rowKind === undefined);
  const leftmost = placedAny ? Math.min(...boxes.map((b) => b.x)) : left;
  const topmost = placedAny ? Math.min(...boxes.map((b) => b.y)) : top;
  let spot: NameSpot = { mode: 'tab' };
  const free = leftmost - PAD_X - 4;
  if (nameW <= free && free >= NAME_MIN_FREE) spot = { mode: 'inline', x: PAD_X, y: 0, w: free };
  else if (topmost >= BAND_PX) spot = { mode: 'band', x: PAD_X, y: 0, w: availW };
  return { boxes, byId: new Map(boxes.map((b) => [b.id, b])), scale, name: spot };
}

const layoutCache = new WeakMap<readonly PortView[], Map<string, FaceplateLayout>>();

/** `layoutFaceplate`, remembered per ports array and height so a cable end
 * and the plate itself share one result. */
export function faceplateLayoutFor(ports: readonly PortView[], heightU: number, name: string): FaceplateLayout {
  let byKey = layoutCache.get(ports);
  if (byKey == null) layoutCache.set(ports, (byKey = new Map()));
  const key = `${heightU}|${name.length}`;
  let layout = byKey.get(key);
  if (layout == null) byKey.set(key, (layout = layoutFaceplate(ports, heightU, name)));
  return layout;
}

const CONNECTOR_NAMES: Record<string, string> = {
  rj45: 'RJ45',
  sfp: 'SFP',
  sfp_plus: 'SFP+',
  sfp28: 'SFP28',
  qsfp: 'QSFP',
  qsfp28: 'QSFP28',
  lc: 'LC',
  sc: 'SC',
  c13: 'C13',
  c14: 'C14',
};

export function connectorName(connector: string): string {
  const key = connector.trim().toLowerCase().replace('+', '_plus');
  return CONNECTOR_NAMES[key] ?? connector.toUpperCase();
}

const ORDINALS = ['1st', '2nd', '3rd'];
function ordinal(n: number): string {
  return ORDINALS[n - 1] ?? `${n}th`;
}

/** "top row, 4th from left" — where one port sits on the plate. */
export function portWhere(layout: FaceplateLayout, portId: string): string | null {
  const box = layout.byId.get(portId);
  if (box == null) return null;
  const sameRow = layout.boxes.filter((b) => b.row === box.row).sort((a, b) => a.x - b.x);
  const place = box.row === 0 ? 'top row' : box.row === 1 ? 'bottom row' : layout.boxes.some((b) => b.row >= 0) ? 'between the rows' : '';
  const nth = `${ordinal(sameRow.findIndex((b) => b.id === portId) + 1)} from left`;
  return place === '' ? nth : `${place}, ${nth}`;
}

/** The unit's ports in words, one line per group: "24 × RJ45, ports 1–24, two rows". */
export function describePorts(ports: readonly PortView[], layout: FaceplateLayout): string[] {
  const groups = new Map<string, PortView[]>();
  for (const p of ports) {
    const kind = p.role === 'management' || p.role === 'console' ? p.role : p.uplink ? 'uplink' : 'access';
    const key = `${p.face}|${connectorName(p.connector)}|${kind}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const lines: string[] = [];
  for (const [key, members] of groups) {
    const [face, conn, kind] = key.split('|') as [string, string, string];
    const labels = members.map((m) => m.label).sort(natural);
    const named = kind === 'management' || kind === 'console';
    let line = named ? `${conn} ${kind}` : `${members.length} × ${conn}`;
    if (named && members.length > 1) line = `${members.length} × ${line}`;
    if (!named || labels[0] !== '') {
      line += labels.length === 1 ? `, ${labels[0]}` : `, ports ${labels[0]}–${labels[labels.length - 1]}`;
    }
    const boxes = members.map((m) => layout.byId.get(m.id)).filter((b): b is PortBox => b != null);
    if (boxes.some((b) => b.row === 0) && boxes.some((b) => b.row === 1)) line += ', two rows';
    if (kind === 'uplink') line += ', uplinks';
    if (boxes.length > 0 && layout.boxes.length > 0) {
      const lo = Math.min(...layout.boxes.map((b) => b.x));
      const hi = Math.max(...layout.boxes.map((b) => b.x + b.w));
      const at = (boxes.reduce((n, b) => n + b.x + b.w / 2, 0) / boxes.length - lo) / Math.max(1, hi - lo);
      if (members.length < ports.length) line += at > 0.75 ? ', on the right' : at < 0.25 ? ', on the left' : '';
    }
    if (face === 'rear') line += ', on the rear';
    lines.push(line);
  }
  return lines;
}

/** An inlet laid out like a port, after the faceplate's own ports, at the
 * plate's trailing edge (ADR-0050 §1: "an inlet strip at the plate's end"). */
function inletAsPort(inlet: InletView, index: number): PortView {
  return {
    ...inlet,
    rowKind: inlet.position?.row ?? 'single',
    row: inlet.position?.row === 'bottom' ? 1 : 0,
    column: 1000 + (inlet.position?.column ?? index),
    gapBefore: index === 0,
    connector: inlet.connector || 'c14',
  };
}

const itemsCache = new WeakMap<readonly PortView[], WeakMap<readonly InletView[], PortView[]>>();

/** What the plate lays out: its ports, plus the inlets in the rear elevation.
 * The same array every call for the same inputs. */
export function plateItems(ports: readonly PortView[], inlets: readonly InletView[], elevation: Facing): readonly PortView[] {
  if (elevation !== 'rear' || inlets.length === 0) return ports;
  let byInlets = itemsCache.get(ports);
  if (byInlets == null) itemsCache.set(ports, (byInlets = new WeakMap()));
  let items = byInlets.get(inlets);
  if (items == null) byInlets.set(inlets, (items = [...ports, ...inlets.map(inletAsPort)]));
  return items;
}
