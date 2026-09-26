// The rack sheet: front and rear elevations to scale, a device table.
// The elevation stays whole on the first page, scaled down if needed; the table continues on further pages, header repeated.
import type { Facing } from '../components/drawing/elevation';
import { faceplateItem } from '../components/drawing/elevation';
import type { ChassisView, OccupantView, RackView, ShelfView } from '../document/view';
import { contentHeightMm, type PaperSize } from './paper';
import { unitRangeLabel } from './units';

/** Millimetres one rack unit draws at when a page has room for it. */
export const ELEVATION_ROW_MM = 6;
/** The FRONT/REAR caption strip above the frame. */
export const ELEVATION_CAPTION_MM = 4;

/** How tall one rack unit draws, scaled down only if the natural size would
 * overflow one page's content area — an elevation never splits across pages. */
export function elevationRowMm(heightU: number, paper: PaperSize): number {
  const budget = contentHeightMm(paper) - ELEVATION_CAPTION_MM;
  const natural = heightU * ELEVATION_ROW_MM;
  return natural <= budget ? ELEVATION_ROW_MM : budget / heightU;
}

/** The elevation's own real rendered height — rows plus the caption strip
 * — what both the SVG's own height and a page budget must agree on. */
export function elevationHeightMm(heightU: number, paper: PaperSize): number {
  return heightU * elevationRowMm(heightU, paper) + ELEVATION_CAPTION_MM;
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
  cableId: string;
  /** The sheath word, `null` when none — black-and-white mode writes this
   * beside the line instead of relying on its ink. */
  sheath: string | null;
}

/** A cable this rack's elevation actually draws — both ends are chassis in
 * this rack, on this elevation's own visible face. Elsewhere is left to the table's "ports cabled" count. */
export function elevationCableLines(
  chassis: readonly ChassisView[],
  elevation: Facing,
  sheathByCableId: ReadonlyMap<string, string | null> = new Map(),
): ElevationCableLine[] {
  const inRack = new Set(chassis.map((c) => c.id));
  const seen = new Set<string>();
  const lines: ElevationCableLine[] = [];
  for (const c of chassis) {
    const item = faceplateItem(c, elevation);
    for (const port of [...item.ports, ...item.inlets]) {
      const cable = port.cable;
      if (cable == null || cable.farChassisId == null) continue;
      if (!inRack.has(cable.farChassisId)) continue;
      if (seen.has(cable.cableId)) continue;
      seen.add(cable.cableId);
      lines.push({
        fromChassisId: c.id,
        toChassisId: cable.farChassisId,
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

/** Packs measured table rows into pages: `firstPageBudgetPx` is what the
 * elevation (and the note, when there is one) leaves on page one;
 * `laterPageBudgetPx` is a full page. A page with no room left at all is
 * left empty rather than forced to take a row it cannot fit; only a row
 * wider than a whole later page still gets forced onto its own. Pure. */
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
