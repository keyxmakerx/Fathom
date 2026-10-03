// Assembles whatever the panel asked for into unpaginated sheets — a real
// page split needs measured heights, so that stays in `PrintPreview.tsx`.
import type { CableView, ChassisView, RackView, ShelfView } from '../document/view';
import type { CutSheetDevice } from './cutSheet';
import { cutSheetBodyRows, cutSheetColumnHeaderRow, type CutSheetBodyRow, type CutSheetTableRow } from './cutSheetTable';
import type { PaperSize } from './paper';
import { allCableLines, elevationCableLines, rackDeviceRows, type ElevationCableLine, type RackDeviceRow } from './rackSheet';

/** The page list's rows (r10-print B), in print order. */
export const PRINT_SECTIONS = ['view', 'racks', 'cables', 'ports', 'inventory'] as const;
export type PrintSection = (typeof PRINT_SECTIONS)[number];
export type RackScope = 'all' | 'active';
/** `screen`: only the cables the Cables list currently shows. */
export type CablesOption = 'none' | 'all' | 'screen';

export interface PrintOptions {
  paper: PaperSize;
  rackScope: RackScope;
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
  section: PrintSection;
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

/** Port map, cable schedule and inventory table: a header row, then body rows. */
export interface TableSheetUnpaginated {
  kind: 'table';
  section: PrintSection;
  /** Column widths in percent, summing to 100. */
  widths: readonly number[];
  columnHeader: CutSheetTableRow;
  bodyRows: CutSheetBodyRow[];
  heading: SheetHeading;
}

/** "This view": the canvas as a picture, one page. */
export interface ImageSheetUnpaginated {
  kind: 'image';
  section: PrintSection;
  /** A `data:image/png` URL the browser itself rendered from the live canvas. */
  dataUrl: string;
  heading: SheetHeading;
}

export type SheetUnpaginated = RackSheetUnpaginated | TableSheetUnpaginated | ImageSheetUnpaginated;

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
  shown: ReadonlySet<string> | null,
): RackSheetUnpaginated {
  const sheathByCableId = new Map(cables.map((c) => [c.id, c.sheath] as const));
  const cablesNote = options.cables === 'all' ? 'cables: all' : options.cables === 'screen' ? 'cables: as shown on screen' : 'cables: none';
  const keep = (lines: ElevationCableLine[]) => (options.cables === 'none' ? [] : lines.filter((l) => options.cables === 'all' || shown == null || shown.has(l.cableId)));
  const deviceCount = rack.chassis.length + rack.shelves.reduce((sum, s) => sum + s.occupants.length, 0);
  return {
    kind: 'rack',
    section: 'racks',
    rackId: rack.id,
    rackLabel: rack.label,
    heightU: rack.heightU,
    unitNumbering: rack.unitNumbering,
    chassis: rack.chassis,
    shelves: rack.shelves,
    hideSensitive: options.hideSensitive,
    frontCables: keep(elevationCableLines(rack.chassis, 'front', sheathByCableId)),
    rearCables: keep(elevationCableLines(rack.chassis, 'rear', sheathByCableId)),
    allCables: keep(allCableLines(rack.chassis, sheathByCableId)),
    deviceRows: rackDeviceRows(rack, options.hideSensitive),
    heading: {
      title: `Rack ${rack.label} · ${designName}`,
      detail: `front and rear · ${rack.heightU}U · ${deviceCount} device${deviceCount === 1 ? '' : 's'} · ${cablesNote}`,
    },
  };
}

export const PORT_MAP_WIDTHS = [14, 12, 14, 8, 8, 16, 10, 8, 10];

function buildPortMap(devices: readonly CutSheetDevice[]): TableSheetUnpaginated {
  const portCount = devices.reduce((sum, d) => sum + d.rows.length, 0);
  return {
    kind: 'table',
    section: 'ports',
    widths: PORT_MAP_WIDTHS,
    columnHeader: cutSheetColumnHeaderRow(),
    bodyRows: cutSheetBodyRows(devices),
    heading: { title: 'Port map', detail: `${devices.length} devices · ${portCount} ports · by rack position, top down` },
  };
}

export interface BuildPrintJobInput {
  /** The page-list rows ticked, any order; printed in `PRINT_SECTIONS` order. */
  sections: ReadonlySet<PrintSection>;
  /** Racks to draw — already narrowed by the panel's rack scope. */
  racks: readonly Pick<RackView, 'id' | 'label' | 'heightU' | 'unitNumbering' | 'chassis' | 'shelves'>[];
  /** Every live cable in the closet — only the sheath word is read, for
   * "cable colours also written as words" in black-and-white mode. */
  cables: readonly CableView[];
  cutSheetDevices: readonly CutSheetDevice[];
  /** Cable ids the Cables list shows; `null` when it shows them all. */
  shownCableIds?: ReadonlySet<string> | null;
  /** Ready-made sheets for the sections built outside this file. */
  extra: Partial<Record<PrintSection, SheetUnpaginated[]>>;
  options: PrintOptions;
  meta: PrintMeta;
}

export function buildPrintJob(input: BuildPrintJobInput): PrintJob {
  const sheets: SheetUnpaginated[] = [];
  for (const section of PRINT_SECTIONS) {
    if (!input.sections.has(section)) continue;
    if (section === 'racks') {
      sheets.push(...input.racks.map((rack) => buildRackSheet(rack, input.options, input.cables, input.meta.designName, input.shownCableIds ?? null)));
    } else if (section === 'ports') {
      sheets.push(buildPortMap(input.cutSheetDevices));
    } else {
      sheets.push(...(input.extra[section] ?? []));
    }
  }
  return { sheets, paper: input.options.paper, blackAndWhite: input.options.blackAndWhite, meta: input.meta };
}
