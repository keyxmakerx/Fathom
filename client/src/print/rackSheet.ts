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

function buildCableLine(
  from: ChassisView,
  fromPortId: string,
  fromLabel: string,
  far: ChassisView,
  farPortId: string,
  cableId: string,
  sheathByCableId: ReadonlyMap<string, string | null>,
): ElevationCableLine {
  const toLabel = portLabelOn(far, farPortId) ?? farPortId;
  return {
    fromChassisId: from.id,
    toChassisId: far.id,
    fromPortId,
    toPortId: farPortId,
    fromText: `${from.hostname || '—'} ${fromLabel}`,
    toText: `${far.hostname || '—'} ${toLabel}`,
    cableId,
    sheath: sheathByCableId.get(cableId) ?? null,
  };
}

/** Every cable between two chassis in this rack, once each — for the
 * "Cables:" hop list, which names a cable whether or not it is drawn. */
export function allCableLines(chassis: readonly ChassisView[], sheathByCableId: ReadonlyMap<string, string | null> = new Map()): ElevationCableLine[] {
  const byId = new Map(chassis.map((c) => [c.id, c] as const));
  const seen = new Set<string>();
  const lines: ElevationCableLine[] = [];
  for (const c of chassis) {
    for (const port of [...c.ports, ...c.psuInlets]) {
      const cable = port.cable;
      if (cable == null || cable.farChassisId == null || cable.farPortId == null) continue;
      const far = byId.get(cable.farChassisId);
      if (!far || seen.has(cable.cableId)) continue;
      seen.add(cable.cableId);
      lines.push(buildCableLine(c, port.id, port.label, far, cable.farPortId, cable.cableId, sheathByCableId));
    }
  }
  return lines;
}

/** A cable this elevation actually draws — both ends on THIS face, so an
 * arc never starts or ends where no port is. A cable crossing faces is left to `allCableLines`'s own list. */
export function elevationCableLines(
  chassis: readonly ChassisView[],
  elevation: Facing,
  sheathByCableId: ReadonlyMap<string, string | null> = new Map(),
): ElevationCableLine[] {
  const byId = new Map(chassis.map((c) => [c.id, c] as const));
  function visibleHere(c: ChassisView, portId: string): boolean {
    const item = faceplateItem(c, elevation);
    return item.ports.some((p) => p.id === portId) || item.inlets.some((p) => p.id === portId);
  }
  const seen = new Set<string>();
  const lines: ElevationCableLine[] = [];
  for (const c of chassis) {
    const item = faceplateItem(c, elevation);
    for (const port of [...item.ports, ...item.inlets]) {
      const cable = port.cable;
      if (cable == null || cable.farChassisId == null || cable.farPortId == null) continue;
      const far = byId.get(cable.farChassisId);
      if (!far) continue;
      if (!visibleHere(far, cable.farPortId)) continue;
      if (seen.has(cable.cableId)) continue;
      seen.add(cable.cableId);
      lines.push(buildCableLine(c, port.id, port.label, far, cable.farPortId, cable.cableId, sheathByCableId));
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
const GLYPH_WIDTH_BY_KIND: Record<PortKind, number> = {
  rj45: 0.9,
  'sfp-plus': 1.3,
  'qsfp-plus': 1.7,
  lc: 1.1,
  c14: 1.5,
  generic: 1,
};

function glyphWidthOf(p: PortView): number {
  return GLYPH_WIDTH_BY_KIND[portKindFor(p.connector) ?? 'generic'];
}

function naturalRowWidth(ports: readonly PortView[]): number {
  if (ports.length === 0) return 0;
  return ports.reduce((sum, p) => sum + glyphWidthOf(p), 0) + GLYPH_GAP_UNITS * (ports.length - 1);
}

/** A horizontal band a glyph row may use — never the name's or the
 * model's own reserved space (`deviceFaceplateLayout` below draws them). */
export interface GlyphZone {
  startX: number;
  width: number;
}

/** One row of glyphs, shrunk — never clipped — to fit `zone`; `h` is the
 * height to draw each glyph at, already scaled for the box if it is short. Pure. */
function layoutGlyphRow(row: readonly PortView[], zone: GlyphZone, y: number, h: number, rightAlign: boolean): FaceplateGlyph[] {
  const naturalTotal = naturalRowWidth(row);
  const scale = naturalTotal > zone.width && naturalTotal > 0 ? Math.max(0, zone.width) / naturalTotal : 1;
  let x = rightAlign ? zone.startX + zone.width - naturalTotal * scale : zone.startX;
  return row.map((p) => {
    const w = glyphWidthOf(p) * scale;
    const glyph: FaceplateGlyph = { port: p, x, y, w, h, shape: (portKindFor(p.connector) ?? 'generic') === 'c14' ? 'hex' : 'rect' };
    x += w + GLYPH_GAP_UNITS * scale;
    return glyph;
  });
}

/** Where each port's glyph draws inside `zone`, one row per faceplate row
 * from `y`; `rightAlign` anchors a row at the zone's right edge. Pure. */
export function facePortGlyphs(ports: readonly PortView[], zone: GlyphZone, y: number, rightAlign = false): FaceplateGlyph[] {
  const rows = faceplateGlyphRows(ports);
  return rows.flatMap((row, rowIndex) => layoutGlyphRow(row, zone, y + rowIndex * GLYPH_ROW_STEP_UNITS, GLYPH_H_UNITS, rightAlign));
}

/** Every port and inlet on one row, catalogue row then column — a 1U box
 * has room for one line, so its own top/bottom rows still read together instead of stacking past the box's bottom edge. Pure. */
function singleRowGlyphs(ports: readonly PortView[], zone: GlyphZone, y: number, h: number): FaceplateGlyph[] {
  const flat = [...ports].sort((a, b) => a.row - b.row || a.column - b.column);
  return layoutGlyphRow(flat, zone, y, h, false);
}

export interface TextBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** A rough on-page text width, sans-serif — generous on purpose: the real
 * glyph must never run past what this claims, since nothing clips it. */
function textWidthAt(text: string, fontUnits: number): number {
  return text.length * fontUnits * CHAR_WIDTH_RATIO;
}

const CHAR_WIDTH_RATIO = 0.72;
const NAME_FONT_UNITS = 3;
const MODEL_FONT_DEFAULT_UNITS = 2.4;
/** About 5pt — the smallest the model's own type shrinks to before a name
 * or a great many ports gets to keep crowding it. */
const MODEL_FONT_FLOOR_UNITS = 1.8;
const ZONE_MARGIN_UNITS = 2;
/** A real gap between two neighbouring boxes, so a rounding error in the
 * SVG's own scaling never touches two that only just fit. */
const ZONE_GAP_UNITS = 1.5;
const NAME_LINE_Y = 3.4;
const LOWER_LINE_Y = 6.4;

export interface DeviceFaceplateLayout {
  nameBox: TextBox;
  nameY: number;
  modelBox: TextBox;
  modelY: number;
  modelX: number;
  modelFont: number;
  portGlyphs: FaceplateGlyph[];
  inletGlyphs: FaceplateGlyph[];
}

/** Negotiates one line shared by glyphs and the model's own type: the
 * model keeps its default size as long as that leaves the glyphs some room; past that its type shrinks to the floor instead. Never clips. */
function shareLineWithModel(model: string, glyphsNaturalW: number, availableW: number): { modelFont: number; modelW: number; glyphZoneWidth: number } {
  const room = Math.max(0, availableW - ZONE_GAP_UNITS);
  let modelFont = MODEL_FONT_DEFAULT_UNITS;
  let modelW = textWidthAt(model, modelFont);
  let glyphZoneWidth = room - modelW;
  if (glyphsNaturalW > 0 && glyphZoneWidth <= 0) {
    modelFont = MODEL_FONT_FLOOR_UNITS;
    modelW = textWidthAt(model, modelFont);
    glyphZoneWidth = room - modelW;
  }
  return { modelFont, modelW, glyphZoneWidth: Math.max(0, glyphZoneWidth) };
}

/** How name, model and glyphs share one faceplate without ever clipping:
 * a 1U box puts all three on one line; a taller one puts the name on its own top line, glyphs and model below, scaled to fit `h`. Pure. */
export function deviceFaceplateLayout(
  name: string,
  model: string,
  ports: readonly PortView[],
  inlets: readonly PortView[],
  heightU: number,
  bodyW: number,
  h: number,
): DeviceFaceplateLayout {
  const modelX = bodyW - ZONE_MARGIN_UNITS;

  if (heightU === 1) {
    const y = NAME_LINE_Y;
    const nameW = textWidthAt(name, NAME_FONT_UNITS);
    const combined = [...ports, ...inlets];
    const glyphsNaturalW = naturalRowWidth(combined);
    const afterName = Math.max(0, bodyW - ZONE_MARGIN_UNITS * 2 - nameW - ZONE_GAP_UNITS);
    const { modelFont, modelW, glyphZoneWidth } = shareLineWithModel(model, glyphsNaturalW, afterName);
    const zone: GlyphZone = { startX: ZONE_MARGIN_UNITS + nameW + ZONE_GAP_UNITS, width: glyphZoneWidth };
    const glyphH = Math.min(GLYPH_H_UNITS, Math.max(0, h - ZONE_MARGIN_UNITS * 2));
    return {
      nameBox: { x0: ZONE_MARGIN_UNITS, x1: ZONE_MARGIN_UNITS + nameW, y0: y - NAME_FONT_UNITS, y1: y },
      nameY: y,
      modelBox: { x0: modelX - modelW, x1: modelX, y0: y - modelFont, y1: y },
      modelY: y,
      modelX,
      modelFont,
      portGlyphs: singleRowGlyphs(combined, zone, y - glyphH, glyphH),
      inletGlyphs: [],
    };
  }

  const glyphsNaturalW = Math.max(naturalRowWidth(faceplateGlyphRows(ports)[0] ?? []), naturalRowWidth(faceplateGlyphRows(inlets)[0] ?? []));
  const { modelFont, modelW, glyphZoneWidth } = shareLineWithModel(model, glyphsNaturalW, bodyW - ZONE_MARGIN_UNITS * 2);
  const zone: GlyphZone = { startX: ZONE_MARGIN_UNITS, width: glyphZoneWidth };
  const portRowCount = faceplateGlyphRows(ports).length;
  const inletRowCount = faceplateGlyphRows(inlets).length;
  const rowsNeeded = portRowCount + inletRowCount;
  const verticalBudget = Math.max(0, h - LOWER_LINE_Y - ZONE_MARGIN_UNITS);
  const naturalVertical = Math.max(0, (rowsNeeded - 1) * GLYPH_ROW_STEP_UNITS + GLYPH_H_UNITS);
  const vScale = naturalVertical > verticalBudget && naturalVertical > 0 ? verticalBudget / naturalVertical : 1;
  const rowStep = GLYPH_ROW_STEP_UNITS * vScale;
  const glyphH = GLYPH_H_UNITS * vScale;
  const portGlyphs = faceplateGlyphRows(ports).flatMap((row, i) => layoutGlyphRow(row, zone, LOWER_LINE_Y - glyphH + i * rowStep, glyphH, false));
  const inletGlyphs = faceplateGlyphRows(inlets).flatMap((row, i) =>
    layoutGlyphRow(row, zone, LOWER_LINE_Y - glyphH + (portRowCount + i) * rowStep, glyphH, true),
  );
  return {
    nameBox: { x0: ZONE_MARGIN_UNITS, x1: ZONE_MARGIN_UNITS + textWidthAt(name, NAME_FONT_UNITS), y0: NAME_LINE_Y - NAME_FONT_UNITS, y1: NAME_LINE_Y },
    nameY: NAME_LINE_Y,
    modelBox: { x0: modelX - modelW, x1: modelX, y0: LOWER_LINE_Y - modelFont, y1: LOWER_LINE_Y },
    modelY: LOWER_LINE_Y,
    modelX,
    modelFont,
    portGlyphs,
    inletGlyphs,
  };
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
