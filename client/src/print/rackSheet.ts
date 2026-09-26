// The rack sheet: front and rear elevations to scale, a device table.
// The elevation stays whole on the first page, scaled down if needed; the table continues on further pages, header repeated.
import type { Facing } from '../components/drawing/elevation';
import { faceplateItem } from '../components/drawing/elevation';
import { portKindFor } from '../components/drawing/portGlyph';
import type { PortKind } from '../components/ports';
import type { ChassisView, OccupantView, PortView, RackView, ShelfView } from '../document/view';
import { contentHeightMm, type PaperSize } from './paper';
import { physicalBottomRow, physicalTopRow, unitRangeLabel } from './units';

/** Millimetres one rack unit draws at when a page has room for it. */
export const ELEVATION_ROW_MM = 6;
/** The FRONT/REAR caption strip above the frame. */
export const ELEVATION_CAPTION_MM = 4;

/** How tall one rack unit draws, shrunk only if the natural size would
 * overflow the page — `reservedMm` is real, measured space the notes below it must also keep. */
export function elevationRowMm(heightU: number, paper: PaperSize, reservedMm = 0): number {
  const budget = contentHeightMm(paper) - ELEVATION_CAPTION_MM - reservedMm;
  const natural = heightU * ELEVATION_ROW_MM;
  return natural <= budget ? ELEVATION_ROW_MM : Math.max(0, budget) / heightU;
}

/** The elevation's own real rendered height — rows plus the caption strip
 * — what both the SVG's own height and a page budget must agree on. */
export function elevationHeightMm(heightU: number, paper: PaperSize, reservedMm = 0): number {
  return heightU * elevationRowMm(heightU, paper, reservedMm) + ELEVATION_CAPTION_MM;
}

export interface RackDeviceRow {
  unit: string;
  name: string;
  model: string;
  serial: string;
  managementAddress: string;
  portsCabled: string;
}

const ABSENT = '—';

function cabledCount(ports: readonly { cable: unknown }[]): string {
  const cabled = ports.filter((p) => p.cable != null).length;
  return `${cabled} of ${ports.length}`;
}

/** Every chassis and every shelf occupant in `rack`, top to bottom — a
 * shelf's own occupants are listed at the shelf's unit, named. */
export function rackDeviceRows(rack: Pick<RackView, 'heightU' | 'unitNumbering' | 'chassis' | 'shelves'>, hideSensitive: boolean): RackDeviceRow[] {
  const chassisRows = rack.chassis.map((c) => ({
    positionU: c.positionU,
    row: {
      unit: unitRangeLabel(rack.heightU, rack.unitNumbering, c.positionU, c.heightU),
      name: c.hostname || ABSENT,
      model: c.model || ABSENT,
      serial: hideSensitive ? ABSENT : (c.serial ?? ABSENT),
      managementAddress: hideSensitive ? ABSENT : (c.managementAddress ?? ABSENT),
      portsCabled: cabledCount(c.ports),
    },
  }));
  const shelfRows = rack.shelves.flatMap((shelf) =>
    shelf.occupants.map((occ) => ({
      positionU: shelf.positionU,
      row: {
        unit: unitRangeLabel(rack.heightU, rack.unitNumbering, shelf.positionU, shelf.heightU),
        name: occ.label || ABSENT,
        model: occ.model ?? ABSENT,
        serial: ABSENT,
        managementAddress: ABSENT,
        portsCabled: cabledCount(occ.ports),
      },
    })),
  );
  return [...chassisRows, ...shelfRows].sort((a, b) => b.positionU - a.positionU).map((r) => r.row);
}

export interface ElevationCableLine {
  fromChassisId: string;
  toChassisId: string;
  fromPortId: string;
  toPortId: string;
  /** For the "Cables:" hop list under the elevations — `hostname · port`,
   * each end, so the line reads without a second lookup. */
  fromText: string;
  toText: string;
  cableId: string;
  /** The sheath word, `null` when none — black-and-white mode writes this
   * beside the line instead of relying on its ink. */
  sheath: string | null;
}

function portLabelOn(chassis: ChassisView, portId: string): string | null {
  const found = [...chassis.ports, ...chassis.psuInlets].find((p) => p.id === portId);
  return found ? found.label : null;
}

/** A cable this rack's elevation actually draws — both ends are chassis in
 * this rack, on this elevation's own visible face. Elsewhere is left to the table's "ports cabled" count. */
export function elevationCableLines(
  chassis: readonly ChassisView[],
  elevation: Facing,
  sheathByCableId: ReadonlyMap<string, string | null> = new Map(),
): ElevationCableLine[] {
  const byId = new Map(chassis.map((c) => [c.id, c] as const));
  const seen = new Set<string>();
  const lines: ElevationCableLine[] = [];
  for (const c of chassis) {
    const item = faceplateItem(c, elevation);
    for (const port of [...item.ports, ...item.inlets]) {
      const cable = port.cable;
      if (cable == null || cable.farChassisId == null || cable.farPortId == null) continue;
      const far = byId.get(cable.farChassisId);
      if (!far) continue;
      if (seen.has(cable.cableId)) continue;
      seen.add(cable.cableId);
      const toLabel = portLabelOn(far, cable.farPortId) ?? cable.farPortId;
      lines.push({
        fromChassisId: c.id,
        toChassisId: cable.farChassisId,
        fromPortId: port.id,
        toPortId: cable.farPortId,
        fromText: `${c.hostname || '—'} ${port.label}`,
        toText: `${far.hostname || '—'} ${toLabel}`,
        cableId: cable.cableId,
        sheath: sheathByCableId.get(cable.cableId) ?? null,
      });
    }
  }
  return lines;
}

/** One item the elevation draws at its own unit range — a chassis or a
 * shelf with its occupants. Merges and orders both kinds top to bottom. */
export type ElevationItem =
  | { kind: 'chassis'; positionU: number; heightU: number; chassis: ChassisView }
  | { kind: 'shelf'; positionU: number; heightU: number; shelf: ShelfView; occupants: readonly OccupantView[] };

export function elevationItemsOf(rack: Pick<RackView, 'chassis' | 'shelves'>): ElevationItem[] {
  const chassisItems: ElevationItem[] = rack.chassis.map((c) => ({ kind: 'chassis', positionU: c.positionU, heightU: c.heightU, chassis: c }));
  const shelfItems: ElevationItem[] = rack.shelves.map((s) => ({ kind: 'shelf', positionU: s.positionU, heightU: s.heightU, shelf: s, occupants: s.occupants }));
  return [...chassisItems, ...shelfItems].sort((a, b) => b.positionU - a.positionU);
}

/** The "left out" note's own `margin-top` (`print.css`'s `.print-note`) —
 * not part of `getBoundingClientRect().height`, so a caller adds it by hand. */
export const NOTE_MARGIN_TOP_MM = 2;

/** Packs measured rows into pages against `firstPageBudgetPx`/`laterPageBudgetPx`
 * — a page with no room left is left empty rather than forced to take a row it cannot fit. Pure. */
export function paginateRackTableByHeight(
  rows: readonly { row: RackDeviceRow; heightPx: number }[],
  firstPageBudgetPx: number,
  laterPageBudgetPx: number,
): RackDeviceRow[][] {
  const pages: RackDeviceRow[][] = [];
  let current: RackDeviceRow[] = [];
  let used = 0;
  let budget = firstPageBudgetPx;

  function breakPage() {
    pages.push(current);
    current = [];
    used = 0;
    budget = laterPageBudgetPx;
  }

  for (const r of rows) {
    if (current.length === 0 && budget <= 0) breakPage();
    if (used + r.heightPx > budget && current.length > 0) breakPage();
    current.push(r.row);
    used += r.heightPx;
  }
  if (current.length > 0 || pages.length === 0) pages.push(current);
  return pages;
}

/** A device's ports grouped by `PortView.row`, each row left to right by
 * column — a sketch device's ports all share row 0, so they draw as one row. */
export function faceplateGlyphRows(ports: readonly PortView[]): PortView[][] {
  const byRow = new Map<number, PortView[]>();
  for (const p of ports) {
    const list = byRow.get(p.row) ?? [];
    list.push(p);
    byRow.set(p.row, list);
  }
  return [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => [...list].sort((a, b) => a.column - b.column));
}

export interface FaceplateGlyph {
  port: PortView;
  x: number;
  y: number;
  w: number;
  h: number;
  /** `c14` draws as the hex power-inlet outline; every other kind is a
   * plain rectangle — width is what tells one kind from another. */
  shape: 'rect' | 'hex';
}

const GLYPH_H_UNITS = 1.5;
const GLYPH_GAP_UNITS = 0.35;
const GLYPH_ROW_STEP_UNITS = 2;
const GLYPH_ROW_Y_START_UNITS = 1.1;
const GLYPH_SIDE_MARGIN_UNITS = 2;
const GLYPH_WIDTH_BY_KIND: Record<PortKind, number> = {
  rj45: 0.9,
  'sfp-plus': 1.3,
  'qsfp-plus': 1.7,
  lc: 1.1,
  c14: 1.5,
  generic: 1,
};

/** Where each port's glyph draws, one row per faceplate row, shrunk to fit
 * the body width. `rowOffset` stacks a second glyph group below the first; `rightAlign` anchors a row at the right edge instead of the left. Pure. */
export function facePortGlyphs(
  ports: readonly PortView[],
  bodyW: number,
  opts: { rowOffset?: number; rightAlign?: boolean } = {},
): FaceplateGlyph[] {
  const rowOffset = opts.rowOffset ?? 0;
  const rows = faceplateGlyphRows(ports);
  const available = bodyW - GLYPH_SIDE_MARGIN_UNITS * 2;
  const out: FaceplateGlyph[] = [];
  rows.forEach((row, rowIndex) => {
    const y = GLYPH_ROW_Y_START_UNITS + (rowOffset + rowIndex) * GLYPH_ROW_STEP_UNITS;
    const kinds = row.map((p) => portKindFor(p.connector) ?? 'generic');
    const naturalWidths = kinds.map((k) => GLYPH_WIDTH_BY_KIND[k]);
    const naturalTotal = naturalWidths.reduce((sum, w) => sum + w, 0) + GLYPH_GAP_UNITS * Math.max(0, row.length - 1);
    const scale = naturalTotal > available && naturalTotal > 0 ? available / naturalTotal : 1;
    let x = opts.rightAlign ? bodyW - GLYPH_SIDE_MARGIN_UNITS - naturalTotal * scale : GLYPH_SIDE_MARGIN_UNITS;
    row.forEach((p, i) => {
      const w = naturalWidths[i] * scale;
      out.push({ port: p, x, y, w, h: GLYPH_H_UNITS * scale, shape: kinds[i] === 'c14' ? 'hex' : 'rect' });
      x += w + GLYPH_GAP_UNITS * scale;
    });
  });
  return out;
}

/** Every physical unit row an elevation draws nothing on — hatched, so an
 * empty slot reads as empty rather than as a gap in the drawing. Pure. */
export function emptyUnitRows(heightU: number, items: readonly Pick<ElevationItem, 'positionU' | 'heightU'>[]): number[] {
  const occupied = new Set<number>();
  for (const item of items) {
    const top = physicalTopRow(heightU, item);
    const bottom = physicalBottomRow(heightU, item);
    for (let r = top; r <= bottom; r += 1) occupied.add(r);
  }
  const empty: number[] = [];
  for (let r = 0; r < heightU; r += 1) if (!occupied.has(r)) empty.push(r);
  return empty;
}

/** The elevation's own cables, front and rear together, one line per cable
 * — the "Cables:" hop list under the drawing names each once, not twice. */
export function dedupeCableLines(lines: readonly ElevationCableLine[]): ElevationCableLine[] {
  const seen = new Set<string>();
  const out: ElevationCableLine[] = [];
  for (const line of lines) {
    if (seen.has(line.cableId)) continue;
    seen.add(line.cableId);
    out.push(line);
  }
  return out;
}
