// Assembles whatever the panel asked for into unpaginated sheets — a real
// page split needs measured heights, so that stays in `PrintPreview.tsx`.
import type { CableView, ChassisView, RackView, ShelfView } from '../document/view';
import type { CutSheetDevice } from './cutSheet';
import { cutSheetBodyRows, cutSheetColumnHeaderRow, type CutSheetBodyRow, type CutSheetTableRow } from './cutSheetTable';
import type { PaperSize } from './paper';
import { allCableLines, elevationCableLines, rackDeviceRows, type ElevationCableLine, type RackDeviceRow } from './rackSheet';

export type PrintWhat = 'this-rack' | 'closet' | 'cut-sheet';
export type CablesOption = 'none' | 'all';

export interface PrintOptions {
  paper: PaperSize;
  cables: CablesOption;
  hideSensitive: boolean;
  blackAndWhite: boolean;
}

export interface PrintMeta {
  designName: string;
  /** "Site › Building › Closet" — never the organisation's name. */
  path: string;
  printedBy: string;
  printedAt: Date;
}

/** The page header's own two halves — bold title left, muted detail right,
 * e.g. "Rack R1 · Loft" and "front and rear · 24U · 8 devices · cables: all". */
export interface SheetHeading {
  title: string;
  detail: string;
}

export interface RackSheetUnpaginated {
  kind: 'rack';
  rackId: string;
  rackLabel: string;
  heightU: number;
  unitNumbering: string;
  chassis: ChassisView[];
  shelves: ShelfView[];
  hideSensitive: boolean;
  frontCables: ElevationCableLine[];
  rearCables: ElevationCableLine[];
  /** Every cable, drawn or not — what the "Cables:" hop list reads. */
  allCables: ElevationCableLine[];
  deviceRows: RackDeviceRow[];
  heading: SheetHeading;
}

export interface CutSheetUnpaginated {
  kind: 'cutsheet';
  columnHeader: CutSheetTableRow;
  bodyRows: CutSheetBodyRow[];
  heading: SheetHeading;
}

export type SheetUnpaginated = RackSheetUnpaginated | CutSheetUnpaginated;

export interface PrintJob {
  sheets: SheetUnpaginated[];
  paper: PaperSize;
  blackAndWhite: boolean;
  meta: PrintMeta;
}

function buildRackSheet(
  rack: Pick<RackView, 'id' | 'label' | 'heightU' | 'unitNumbering' | 'chassis' | 'shelves'>,
  options: Pick<PrintOptions, 'cables' | 'hideSensitive'>,
  cables: readonly CableView[],
  designName: string,
): RackSheetUnpaginated {
  const sheathByCableId = new Map(cables.map((c) => [c.id, c.sheath] as const));
  const cablesNote = options.cables === 'all' ? 'cables: all' : 'cables: none';
  const deviceCount = rack.chassis.length + rack.shelves.reduce((sum, s) => sum + s.occupants.length, 0);
  return {
    kind: 'rack',
    rackId: rack.id,
    rackLabel: rack.label,
    heightU: rack.heightU,
    unitNumbering: rack.unitNumbering,
    chassis: rack.chassis,
    shelves: rack.shelves,
    hideSensitive: options.hideSensitive,
    frontCables: options.cables === 'all' ? elevationCableLines(rack.chassis, 'front', sheathByCableId) : [],
    rearCables: options.cables === 'all' ? elevationCableLines(rack.chassis, 'rear', sheathByCableId) : [],
    allCables: options.cables === 'all' ? allCableLines(rack.chassis, sheathByCableId) : [],
    deviceRows: rackDeviceRows(rack, options.hideSensitive),
    heading: {
      title: `Rack ${rack.label} · ${designName}`,
      detail: `front and rear · ${rack.heightU}U · ${deviceCount} device${deviceCount === 1 ? '' : 's'} · ${cablesNote}`,
    },
  };
}

function buildCutSheet(devices: readonly CutSheetDevice[]): CutSheetUnpaginated {
  const portCount = devices.reduce((sum, d) => sum + d.rows.length, 0);
  return {
    kind: 'cutsheet',
    columnHeader: cutSheetColumnHeaderRow(),
    bodyRows: cutSheetBodyRows(devices),
    heading: { title: 'Cut sheet', detail: `${devices.length} devices · ${portCount} ports · by rack position, top down` },
  };
}

export interface BuildPrintJobInput {
  what: PrintWhat;
  racks: readonly Pick<RackView, 'id' | 'label' | 'heightU' | 'unitNumbering' | 'chassis' | 'shelves'>[];
  /** Every live cable in the closet — only the sheath word is read, for
   * "cable colours also written as words" in black-and-white mode. */
  cables: readonly CableView[];
  cutSheetDevices: readonly CutSheetDevice[];
  options: PrintOptions;
  meta: PrintMeta;
}

export function buildPrintJob(input: BuildPrintJobInput): PrintJob {
  const sheets: SheetUnpaginated[] =
    input.what === 'cut-sheet'
      ? [buildCutSheet(input.cutSheetDevices)]
      : input.racks.map((rack) => buildRackSheet(rack, input.options, input.cables, input.meta.designName));
  return { sheets, paper: input.options.paper, blackAndWhite: input.options.blackAndWhite, meta: input.meta };
}
