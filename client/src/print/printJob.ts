// Assembles whatever the panel asked for into unpaginated sheets — a real
// page split needs measured heights, so that stays in `PrintPreview.tsx`.
import type { CableView, ChassisView, RackView, ShelfView } from '../document/view';
import type { CutSheetDevice } from './cutSheet';
import { cutSheetBodyRows, cutSheetColumnHeaderRow, type CutSheetBodyRow, type CutSheetTableRow } from './cutSheetTable';
import type { PaperSize } from './paper';
import { elevationCableLines, rackDeviceRows, type ElevationCableLine, type RackDeviceRow } from './rackSheet';

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
  deviceRows: RackDeviceRow[];
  sheetLabel: string;
}

export interface CutSheetUnpaginated {
  kind: 'cutsheet';
  columnHeader: CutSheetTableRow;
  bodyRows: CutSheetBodyRow[];
  sheetLabel: string;
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
): RackSheetUnpaginated {
  const sheathByCableId = new Map(cables.map((c) => [c.id, c.sheath] as const));
  const cablesNote = options.cables === 'all' ? 'cables: all' : 'cables: none';
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
    deviceRows: rackDeviceRows(rack, options.hideSensitive),
    sheetLabel: `Rack ${rack.label} · front and rear · ${cablesNote}`,
  };
}

function buildCutSheet(devices: readonly CutSheetDevice[]): CutSheetUnpaginated {
  const portCount = devices.reduce((sum, d) => sum + d.rows.length, 0);
  return {
    kind: 'cutsheet',
    columnHeader: cutSheetColumnHeaderRow(),
    bodyRows: cutSheetBodyRows(devices),
    sheetLabel: `Cut sheet · ${devices.length} devices · ${portCount} ports · by rack position, top down`,
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
      : input.racks.map((rack) => buildRackSheet(rack, input.options, input.cables));
  return { sheets, paper: input.options.paper, blackAndWhite: input.options.blackAndWhite, meta: input.meta };
}
