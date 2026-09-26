// The rack sheet: front and rear elevations to scale with unit numbers, a
// device table (unit, name, model, serial, management address, ports
// cabled), cables none or all. The elevation always stays whole on the
// first page, scaled down if a rack is too tall to draw at full size; the
// device table continues onto further pages, repeating its own header.
import type { Facing } from '../components/drawing/elevation';
import { faceplateItem } from '../components/drawing/elevation';
import type { ChassisView, OccupantView, RackView, ShelfView } from '../document/view';
import { contentHeightMm, type PaperSize } from './paper';
import { unitRangeLabel } from './units';

/** Millimetres one rack unit draws at when a page has room for it. */
export const ELEVATION_ROW_MM = 6;
/** The FRONT/REAR caption strip above the frame. */
export const ELEVATION_CAPTION_MM = 4;

/** How tall one rack unit draws, scaled down only if `heightU` at the
 * natural size (plus the caption strip) would be taller than one page's own
 * content area — an elevation never splits across pages, so it must always
 * fit whole. */
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

/** Every chassis and every shelf occupant in `rack`, top to bottom —
 * shelves are drawn and listed at their own units, occupants named,
 * alongside ordinary rack-mounted chassis. */
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
  /** The sheath word (`CableView.sheath`), `null` when the cable carries
   * none — black-and-white mode writes this beside the line instead of
   * relying on its ink. */
  sheath: string | null;
}

/** A cable this rack's elevation actually draws — both ends are chassis in
 * this same rack and both faceplates show on `elevation` (`faceplateItem`'s
 * own visible face, `components/drawing/elevation.ts`, reused rather than
 * re-derived). A cable elsewhere is left to the device table's own "ports
 * cabled" count. */
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
 * shelf (with its occupants named on the band, `PrintPreview.tsx`'s own
 * render). Merges and orders both kinds top to bottom. */
export type ElevationItem =
  | { kind: 'chassis'; positionU: number; heightU: number; chassis: ChassisView }
  | { kind: 'shelf'; positionU: number; heightU: number; shelf: ShelfView; occupants: readonly OccupantView[] };

export function elevationItemsOf(rack: Pick<RackView, 'chassis' | 'shelves'>): ElevationItem[] {
  const chassisItems: ElevationItem[] = rack.chassis.map((c) => ({ kind: 'chassis', positionU: c.positionU, heightU: c.heightU, chassis: c }));
  const shelfItems: ElevationItem[] = rack.shelves.map((s) => ({ kind: 'shelf', positionU: s.positionU, heightU: s.heightU, shelf: s, occupants: s.occupants }));
  return [...chassisItems, ...shelfItems].sort((a, b) => b.positionU - a.positionU);
}

/**
 * Packs measured table rows into pages: `firstPageBudgetPx` is what is left
 * once the elevation (and the page's own header) have taken their share on
 * page one; `laterPageBudgetPx` is a full page's content height minus the
 * table's own repeated header. A row that alone exceeds a page's budget
 * still gets a page rather than being dropped or split — pure, so it is
 * tested with fabricated heights, never a real render.
 */
export function paginateRackTableByHeight(
  rows: readonly { row: RackDeviceRow; heightPx: number }[],
  firstPageBudgetPx: number,
  laterPageBudgetPx: number,
): RackDeviceRow[][] {
  const pages: RackDeviceRow[][] = [];
  let current: RackDeviceRow[] = [];
  let used = 0;
  let budget = firstPageBudgetPx;

  for (const r of rows) {
    if (used + r.heightPx > budget && current.length > 0) {
      pages.push(current);
      current = [];
      used = 0;
      budget = laterPageBudgetPx;
    }
    current.push(r.row);
    used += r.heightPx;
  }
  if (current.length > 0 || pages.length === 0) pages.push(current);
  return pages;
}
