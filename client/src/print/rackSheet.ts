// The rack sheet — brief item 3: front and rear elevations to scale with
// unit numbers, and a device table (unit, name, model, serial, management
// address, ports cabled); cables none or all; a rack taller than one page
// splits, never losing or doubling a device row.
import type { Facing } from '../components/drawing/elevation';
import { faceplateItem } from '../components/drawing/elevation';
import type { ChassisView, RackView } from '../document/view';
import { contentHeightMm, type PaperSize } from './paper';
import { physicalBottomRow, physicalTopRow, unitRangeLabel } from './units';

/** Millimetres one rack unit draws at, in the elevation. */
export const ELEVATION_ROW_MM = 6;
/** Millimetres one row of the device table takes. */
export const TABLE_ROW_MM = 4.2;
/** How the page's content height is split between the two — the elevation
 * is the taller draw per unit, so it gets the larger share; chosen so a
 * fully populated 42U rack takes exactly two pages on A4 and on Letter
 * (brief's own worked example), never one and never three. */
const ELEVATION_SHARE = 0.55;

/** How many rack units of elevation (and, in step, how many table rows)
 * fit on one page of `paper` — the one number the whole pagination below
 * is built from. A4 and Letter differ here because they differ in height;
 * this is the "paging knows the paper" the brief asks for. */
export function rowsPerPage(paper: PaperSize): number {
  const elevationBudgetMm = contentHeightMm(paper) * ELEVATION_SHARE;
  return Math.max(1, Math.floor(elevationBudgetMm / ELEVATION_ROW_MM));
}

export interface RackPageSlice {
  /** 0-based, from the physical top of the rack, inclusive. */
  fromRow: number;
  toRow: number;
  /** Every chassis whose full occupied span lies inside this slice — never
   * a chassis split across two slices. */
  chassis: ChassisView[];
}

/**
 * Cuts `rack`'s `heightU` rows into slices of at most `capacityRows`,
 * walking top to bottom, never splitting a chassis's own span across a
 * cut and never dropping or doubling one. A chassis taller than a whole
 * page's capacity gets a page of its own rather than being lost.
 */
export function paginateRackRows(rack: Pick<RackView, 'heightU' | 'chassis'>, capacityRows: number): RackPageSlice[] {
  const items = rack.chassis
    .map((c) => ({ c, top: physicalTopRow(rack.heightU, c), bottom: physicalBottomRow(rack.heightU, c) }))
    .sort((a, b) => a.top - b.top);
  const lastRow = rack.heightU - 1;
  const pages: RackPageSlice[] = [];
  let cursor = 0;
  let idx = 0;

  while (cursor <= lastRow) {
    const pageStart = cursor;
    let pageEnd = Math.min(pageStart + capacityRows - 1, lastRow);
    const pageChassis: ChassisView[] = [];
    let i = idx;
    while (i < items.length && items[i].top <= pageEnd) {
      const it = items[i];
      if (it.bottom <= pageEnd) {
        pageChassis.push(it.c);
        i += 1;
        continue;
      }
      // `it` straddles this cut.
      if (it.top === pageStart) {
        // It alone is taller than one page's capacity — give it the page
        // anyway rather than split or drop it.
        pageChassis.push(it.c);
        pageEnd = it.bottom;
        i += 1;
      } else {
        // Move it whole onto the next page instead of cutting into it.
        pageEnd = it.top - 1;
      }
      break;
    }
    pages.push({ fromRow: pageStart, toRow: pageEnd, chassis: pageChassis });
    cursor = pageEnd + 1;
    idx = i;
  }
  return pages.length > 0 ? pages : [{ fromRow: 0, toRow: lastRow, chassis: [] }];
}

export interface RackDeviceRow {
  unit: string;
  name: string;
  model: string;
  serial: string;
  managementAddress: string;
  portsCabled: string;
}

/** One rack sheet page's own device table rows — `hideSensitive` prints a
 * dash for serial/management address (brief item 1's "leave out serials
 * and management addresses"). */
export function rackDeviceRows(rack: Pick<RackView, 'heightU' | 'unitNumbering'>, chassis: readonly ChassisView[], hideSensitive: boolean): RackDeviceRow[] {
  const ABSENT = '—';
  return [...chassis]
    .sort((a, b) => b.positionU - a.positionU)
    .map((c) => {
      const cabled = c.ports.filter((p) => p.cable != null).length;
      return {
        unit: unitRangeLabel(rack.heightU, rack.unitNumbering, c.positionU, c.heightU),
        name: c.hostname || ABSENT,
        model: c.model || ABSENT,
        serial: hideSensitive ? ABSENT : c.serial ?? ABSENT,
        managementAddress: hideSensitive ? ABSENT : c.managementAddress ?? ABSENT,
        portsCabled: `${cabled} of ${c.ports.length}`,
      };
    });
}

export interface ElevationCableLine {
  fromChassisId: string;
  toChassisId: string;
}

/** A cable this page's elevation actually draws — both ends are chassis
 * present on this same page and both faceplates show on `elevation`
 * (`faceplateItem`'s own visible face, `components/drawing/elevation.ts`,
 * reused rather than re-derived). A cable to a different page, a different
 * rack or outside the closet is left to the device table's "ports cabled"
 * count instead of a line this page cannot honestly draw end to end. */
export function elevationCableLines(chassis: readonly ChassisView[], elevation: Facing): ElevationCableLine[] {
  const onPage = new Set(chassis.map((c) => c.id));
  const seen = new Set<string>();
  const lines: ElevationCableLine[] = [];
  for (const c of chassis) {
    const item = faceplateItem(c, elevation);
    for (const port of [...item.ports, ...item.inlets]) {
      const cable = port.cable;
      if (cable == null || cable.farChassisId == null) continue;
      if (!onPage.has(cable.farChassisId)) continue;
      if (seen.has(cable.cableId)) continue;
      seen.add(cable.cableId);
      lines.push({ fromChassisId: c.id, toChassisId: cable.farChassisId });
    }
  }
  return lines;
}
