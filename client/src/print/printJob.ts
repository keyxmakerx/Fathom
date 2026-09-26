// Assembles whatever the panel asked for into one ordered list of pages,
// each carrying the title block brief item 2 asks for — design, path,
// date, printed by, "page x of y" counting every page of everything
// printed in one go, never reset per sheet. `counter(pages)` is not this:
// read 2026-09-26, raw.githubusercontent.com/mdn/browser-compat-data,
// css/types/counter.json carries no "pages" keyword at all — no browser
// implements the CSS Generated-Content-for-Paged-Media total-page counter,
// so the total is computed here, in script, once every page is known.
import type { ChassisView, RackView } from '../document/view';
import type { CutSheetDevice } from './cutSheet';
import { paginateCutSheet, type CutSheetTableRow } from './cutSheetTable';
import type { PaperSize } from './paper';
import { elevationCableLines, paginateRackRows, rackDeviceRows, rowsPerPage, type ElevationCableLine, type RackDeviceRow } from './rackSheet';

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
  /** "Site › Building › Closet". */
  path: string;
  printedBy: string;
  printedAt: Date;
}

export interface TitleBlock {
  design: string;
  path: string;
  date: string;
  printedBy: string;
  sheetLabel: string;
  page: number;
  of: number;
}

export interface RackSheetPageContent {
  kind: 'rack';
  rackId: string;
  rackLabel: string;
  heightU: number;
  unitNumbering: string;
  fromRow: number;
  toRow: number;
  chassis: ChassisView[];
  cablesOption: CablesOption;
  hideSensitive: boolean;
  deviceRows: RackDeviceRow[];
  frontCables: ElevationCableLine[];
  rearCables: ElevationCableLine[];
  pageWithinRack: number;
  pagesForRack: number;
}

export interface CutSheetPageContent {
  kind: 'cutsheet';
  rows: CutSheetTableRow[];
}

export type PrintPageContent = RackSheetPageContent | CutSheetPageContent;

export interface PrintPage {
  content: PrintPageContent;
  titleBlock: TitleBlock;
}

function formatDate(d: Date): string {
  const day = d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${day} ${time}`;
}

export function buildRackSheetPages(
  rack: Pick<RackView, 'id' | 'label' | 'heightU' | 'unitNumbering' | 'chassis'>,
  paper: PaperSize,
  options: Pick<PrintOptions, 'cables' | 'hideSensitive'>,
): RackSheetPageContent[] {
  const capacity = rowsPerPage(paper);
  const slices = paginateRackRows(rack, capacity);
  return slices.map((slice, i) => ({
    kind: 'rack',
    rackId: rack.id,
    rackLabel: rack.label,
    heightU: rack.heightU,
    unitNumbering: rack.unitNumbering,
    fromRow: slice.fromRow,
    toRow: slice.toRow,
    chassis: slice.chassis,
    cablesOption: options.cables,
    hideSensitive: options.hideSensitive,
    deviceRows: rackDeviceRows(rack, slice.chassis, options.hideSensitive),
    frontCables: options.cables === 'all' ? elevationCableLines(slice.chassis, 'front') : [],
    rearCables: options.cables === 'all' ? elevationCableLines(slice.chassis, 'rear') : [],
    pageWithinRack: i + 1,
    pagesForRack: slices.length,
  }));
}

export function buildCutSheetPages(devices: readonly CutSheetDevice[], paper: PaperSize): CutSheetPageContent[] {
  return paginateCutSheet(devices, paper).map((rows) => ({ kind: 'cutsheet', rows }));
}

export interface BuildPrintJobInput {
  what: PrintWhat;
  racks: readonly Pick<RackView, 'id' | 'label' | 'heightU' | 'unitNumbering' | 'chassis'>[];
  cutSheetDevices: readonly CutSheetDevice[];
  options: PrintOptions;
  meta: PrintMeta;
}

/** Every page this print job carries, title-blocked and numbered as one
 * sequence — "page x of y counts every page of everything printed in one
 * go" (brief item 2), never restarted per rack or per sheet kind. */
export function buildPrintJob(input: BuildPrintJobInput): PrintPage[] {
  const contents: { content: PrintPageContent; sheetLabel: string }[] = [];

  if (input.what === 'this-rack' || input.what === 'closet') {
    for (const rack of input.racks) {
      const pages = buildRackSheetPages(rack, input.options.paper, input.options);
      for (const page of pages) {
        const cablesNote = input.options.cables === 'all' ? 'cables: all' : 'cables: none';
        contents.push({ content: page, sheetLabel: `Rack ${rack.label} · front and rear · ${cablesNote}` });
      }
    }
  } else {
    const pages = buildCutSheetPages(input.cutSheetDevices, input.options.paper);
    for (const page of pages) {
      contents.push({ content: page, sheetLabel: 'Cut sheet · per device, all ports' });
    }
  }

  const of = contents.length;
  const date = formatDate(input.meta.printedAt);
  return contents.map((c, i) => ({
    content: c.content,
    titleBlock: {
      design: input.meta.designName,
      path: input.meta.path,
      date,
      printedBy: input.meta.printedBy,
      sheetLabel: c.sheetLabel,
      page: i + 1,
      of,
    },
  }));
}
