import { useLayoutEffect, useRef, useState } from 'react';

import { faceplateItem, type Facing } from '../components/drawing/elevation';
import { contentHeightMm, mmToPx, pageHeightMm, pageWidthMm, pxToMm, type PaperSize } from './paper';
import {
  ELEVATION_CAPTION_MM,
  NOTE_MARGIN_TOP_MM,
  deviceFaceplateLayout,
  elevationHeightMm,
  elevationItemsOf,
  elevationRowMm,
  emptyUnitRows,
  paginateRackTableByHeight,
  type ElevationCableLine,
  type ElevationItem,
  type FaceplateGlyph,
  type RackDeviceRow,
} from './rackSheet';
import { paginateCutSheetByHeight, type CutSheetTableRow } from './cutSheetTable';
import type { PrintJob, RackSheetUnpaginated, SheetHeading } from './printJob';
import './print.css';

const HIDE_SENSITIVE_NOTE = 'Serial numbers and management addresses left out of this printout.';

/** The board's own "Cables: …" line under the elevations, plus the hop
 * list when any are drawn — front and rear cables named once each. */
function CablesNote({ sheet, dataRowId }: { sheet: RackSheetUnpaginated; dataRowId?: string }) {
  const lines = sheet.allCables;
  return (
    <div className="print-cables-note" data-row-id={dataRowId}>
      <div>
        <span className="print-cables-note__mark">Cables:</span> {lines.length > 0 ? `all · ${lines.length}` : 'none'}
      </div>
      {lines.length > 0 && <div className="print-cables-note__list">{lines.map((l) => `${l.fromText} → ${l.toText}`).join(' · ')}</div>}
    </div>
  );
}

interface TitleBlock {
  design: string;
  path: string;
  date: string;
  printedBy: string;
  page: number;
  of: number;
}

interface RackPageContent {
  kind: 'rack';
  sheet: RackSheetUnpaginated;
  showElevation: boolean;
  rows: RackDeviceRow[];
  /** Real, measured space the notes below the elevation take on page one —
   * the elevation itself must leave this much room, not just the table. */
  reservedMm: number;
}

interface CutSheetPageContent {
  kind: 'cutsheet';
  rows: CutSheetTableRow[];
}

type PageContent = RackPageContent | CutSheetPageContent;

interface FinalPage {
  content: PageContent;
  heading: SheetHeading;
  titleBlock: TitleBlock;
}

function formatDate(d: Date): string {
  const day = d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${day} ${time}`;
}

/** Reads every `[data-row-id]` under `container`, its own rendered height
 * — the one DOM query the whole measuring pass needs. */
function measureRowHeights(container: HTMLElement): Map<string, number> {
  const heights = new Map<string, number>();
  container.querySelectorAll<HTMLElement>('[data-row-id]').forEach((el) => {
    heights.set(el.dataset.rowId!, el.getBoundingClientRect().height);
  });
  return heights;
}

function buildFinalPages(job: PrintJob, heights: Map<string, number>): FinalPage[] {
  const capacityPx = mmToPx(contentHeightMm(job.paper));
  const built: { content: PageContent; heading: SheetHeading }[] = [];

  job.sheets.forEach((sheet, sheetIndex) => {
    if (sheet.kind === 'rack') {
      const theadPx = heights.get(`${sheetIndex}:thead`) ?? 0;
      const notePx = sheet.hideSensitive ? (heights.get(`${sheetIndex}:note`) ?? 0) + mmToPx(NOTE_MARGIN_TOP_MM) : 0;
      const cablesShown = sheet.allCables.length > 0;
      const cablesNotePx = cablesShown ? (heights.get(`${sheetIndex}:cablesNote`) ?? 0) : 0;
      const reservedMm = pxToMm(notePx) + pxToMm(cablesNotePx);
      const elevationPx = mmToPx(elevationHeightMm(sheet.heightU, job.paper, reservedMm));
      const rows = sheet.deviceRows.map((row, i) => ({ row, heightPx: heights.get(`${sheetIndex}:r${i}`) ?? 0 }));
      const firstBudget = Math.max(0, capacityPx - elevationPx - notePx - cablesNotePx - theadPx);
      const laterBudget = Math.max(0, capacityPx - theadPx);
      const pages = paginateRackTableByHeight(rows, firstBudget, laterBudget);
      pages.forEach((pageRows, pageIndex) => {
        built.push({
          content: { kind: 'rack', sheet, showElevation: pageIndex === 0, rows: pageRows, reservedMm },
          heading: sheet.heading,
        });
      });
    } else {
      const headerPx = heights.get(`${sheetIndex}:header`) ?? 0;
      const bodyRows = sheet.bodyRows.map((u, i) => ({ ...u, heightPx: heights.get(`${sheetIndex}:b${i}`) ?? 0 }));
      const pages = paginateCutSheetByHeight({ row: sheet.columnHeader, heightPx: headerPx }, bodyRows, capacityPx);
      pages.forEach((rows) => built.push({ content: { kind: 'cutsheet', rows }, heading: sheet.heading }));
    }
  });

  const of = built.length;
  const date = formatDate(job.meta.printedAt);
  return built.map((b, i) => ({
    content: b.content,
    heading: b.heading,
    titleBlock: { design: job.meta.designName, path: job.meta.path, date, printedBy: job.meta.printedBy, page: i + 1, of },
  }));
}

export interface PrintPreviewProps {
  job: PrintJob;
  onClose: () => void;
}

/** The panel's own "Print" click lands here: a hidden pass measures every
 * row's real height, then pure functions paginate from that. Ctrl+P prints. */
export function PrintPreview({ job, onClose }: PrintPreviewProps) {
  const [finalPages, setFinalPages] = useState<FinalPage[] | null>(null);
  const measureRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    setFinalPages(null);
  }, [job]);

  useLayoutEffect(() => {
    if (finalPages != null) return;
    const container = measureRef.current;
    if (!container) return;
    const heights = measureRowHeights(container);
    setFinalPages(buildFinalPages(job, heights));
  }, [job, finalPages]);

  // Page margin and hiding the live drawing from print apply only while
  // this preview is mounted — another screen's own print is never affected.
  useLayoutEffect(() => {
    const style = document.createElement('style');
    style.textContent = '@page { margin: 0; } @media print { .print-hide-under-preview { display: none !important; } }';
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, []);

  // A window-level capture listener, ahead of everything else the page owns
  // — Tab keeps its default behaviour; `inert` below keeps the place out of the tab order.
  useLayoutEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      event.stopImmediatePropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        window.print();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return (
    <div className="print-preview" data-testid="print-preview">
      <div className="print-preview__bar no-print">
        <span>
          {finalPages ? finalPages.length : '…'} page{finalPages?.length === 1 ? '' : 's'} {'·'} {job.paper} {'·'} Save as PDF is in the print dialog
        </span>
        <button type="button" onClick={() => window.print()} data-testid="print-preview-print">
          Print
        </button>
        <button type="button" onClick={onClose} data-testid="print-preview-close">
          Close
        </button>
      </div>

      <MeasuringPass job={job} containerRef={measureRef} />

      <div className="print-preview__pages">
        {finalPages == null
          ? null
          : finalPages.map((page, i) => <Page key={i} page={page} paper={job.paper} blackAndWhite={job.blackAndWhite} />)}
      </div>
    </div>
  );
}

/** Renders every sheet's rows unsplit, off-screen, inside a real `.print-page`
 * — its own line-height and padding must apply, or a measured row reads about twice its real height. */
function MeasuringPass({ job, containerRef }: { job: PrintJob; containerRef: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={containerRef} className="print-page print-measure" style={{ width: `${pageWidthMm(job.paper)}mm` }}>
      {job.sheets.map((sheet, i) =>
        sheet.kind === 'rack' ? (
          <div key={i}>
            <table className="print-table">
              <RackTableHead dataRowId={`${i}:thead`} />
              <tbody>
                {sheet.deviceRows.map((row, r) => (
                  <RackTableRow key={r} row={row} dataRowId={`${i}:r${r}`} />
                ))}
              </tbody>
            </table>
            {sheet.hideSensitive && (
              <div className="print-note" data-row-id={`${i}:note`}>
                {HIDE_SENSITIVE_NOTE}
              </div>
            )}
            {sheet.allCables.length > 0 && <CablesNote sheet={sheet} dataRowId={`${i}:cablesNote`} />}
          </div>
        ) : (
          <table key={i} className="print-table print-table--cutsheet">
            <ColGroup widths={CUT_SHEET_COLUMN_WIDTHS} />
            <tbody>
              <CutSheetRow row={sheet.columnHeader} dataRowId={`${i}:header`} />
              {sheet.bodyRows.map((u, r) => (
                <CutSheetRow key={r} row={u.row} dataRowId={`${i}:b${r}`} />
              ))}
            </tbody>
          </table>
        ),
      )}
    </div>
  );
}

function Page({ page, paper, blackAndWhite }: { page: FinalPage; paper: PaperSize; blackAndWhite: boolean }) {
  const w = pageWidthMm(paper);
  const h = pageHeightMm(paper);
  return (
    <div className="print-page" style={{ width: `${w}mm`, height: `${h}mm` }} data-testid="print-page">
      <div className="print-page__header">
        <span className="print-page__header-title">{page.heading.title}</span>
        <span className="print-page__header-detail">{page.heading.detail}</span>
      </div>
      <div className="print-page__content">
        {page.content.kind === 'rack' ? (
          <RackSheetContent content={page.content} paper={paper} blackAndWhite={blackAndWhite} />
        ) : (
          <table className="print-table print-table--cutsheet" data-testid="print-cutsheet-table">
            <ColGroup widths={CUT_SHEET_COLUMN_WIDTHS} />
            <tbody>
              {page.content.rows.map((row, i) => (
                <CutSheetRow key={i} row={row} />
              ))}
            </tbody>
          </table>
        )}
      </div>
      <TitleBlockRow titleBlock={page.titleBlock} />
    </div>
  );
}

function TitleBlockRow({ titleBlock }: { titleBlock: TitleBlock }) {
  return (
    <div className="print-title-block" data-testid="print-title-block">
      <div className="print-title-block__mark">Fathom</div>
      <div className="print-title-block__mid">
        <div className="print-title-block__design">{titleBlock.design}</div>
        <div className="print-title-block__path">{titleBlock.path}</div>
      </div>
      <div className="print-title-block__cell">
        <div className="print-title-block__label">printed</div>
        <div className="print-title-block__value">{titleBlock.date}</div>
        <div className="print-title-block__value print-title-block__value--muted">{titleBlock.printedBy}</div>
      </div>
      <div className="print-title-block__cell">
        <div className="print-title-block__label">page</div>
        <div className="print-title-block__value print-title-block__value--page" data-testid="print-page-of">
          {titleBlock.page} of {titleBlock.of}
        </div>
      </div>
    </div>
  );
}

const RACK_COLUMN_WIDTHS = [8, 22, 20, 16, 18, 16];

function RackTableHead({ dataRowId }: { dataRowId?: string }) {
  return (
    <thead>
      <tr data-row-id={dataRowId}>
        <th>Unit</th>
        <th>Name</th>
        <th>Model</th>
        <th>Serial</th>
        <th>Management address</th>
        <th>Ports cabled</th>
      </tr>
    </thead>
  );
}

function RackTableRow({ row, dataRowId }: { row: RackDeviceRow; dataRowId?: string }) {
  return (
    <tr data-row-id={dataRowId}>
      <td>{row.unit}</td>
      <td className="print-table__bold">{row.name}</td>
      <td>{row.model}</td>
      <td>{row.serial}</td>
      <td>{row.managementAddress}</td>
      <td>{row.portsCabled}</td>
    </tr>
  );
}

function ColGroup({ widths }: { widths: readonly number[] }) {
  return (
    <colgroup>
      {widths.map((w, i) => (
        <col key={i} style={{ width: `${w}%` }} />
      ))}
    </colgroup>
  );
}

function CutSheetRow({ row, dataRowId }: { row: CutSheetTableRow; dataRowId?: string }) {
  return (
    <tr data-row-id={dataRowId} className={row.bold ? 'print-table__filled' : undefined}>
      {row.cells.map((cell, j) => (
        <td key={j}>{cell}</td>
      ))}
    </tr>
  );
}

const CUT_SHEET_COLUMN_WIDTHS = [14, 12, 14, 8, 8, 16, 10, 8, 10];

function RackSheetContent({ content, paper, blackAndWhite }: { content: RackPageContent; paper: PaperSize; blackAndWhite: boolean }) {
  const { sheet, showElevation, rows, reservedMm } = content;
  const items = elevationItemsOf(sheet);
  const rowMm = elevationRowMm(sheet.heightU, paper, reservedMm);
  return (
    <div className="print-rack-sheet">
      {showElevation && (
        <div className="print-rack-sheet__elevations">
          <Elevation items={items} heightU={sheet.heightU} unitNumbering={sheet.unitNumbering} rowMm={rowMm} elevation="front" blackAndWhite={blackAndWhite} cableLines={sheet.frontCables} />
          <Elevation items={items} heightU={sheet.heightU} unitNumbering={sheet.unitNumbering} rowMm={rowMm} elevation="rear" blackAndWhite={blackAndWhite} cableLines={sheet.rearCables} />
        </div>
      )}
      {showElevation && sheet.allCables.length > 0 && <CablesNote sheet={sheet} />}
      <table className="print-table" data-testid="print-rack-device-table">
        <ColGroup widths={RACK_COLUMN_WIDTHS} />
        <RackTableHead />
        <tbody>
          {rows.map((row, i) => (
            <RackTableRow key={i} row={row} />
          ))}
        </tbody>
      </table>
      {showElevation && sheet.hideSensitive && <div className="print-note">{HIDE_SENSITIVE_NOTE}</div>}
    </div>
  );
}

function unitLabelOf(heightU: number, unitNumbering: string, positionU: number): number {
  return unitNumbering === 'descending' ? heightU - positionU + 1 : positionU;
}

/** An octagon, corners cut at 30% of the shorter side — the same silhouette
 * `C14.tsx`'s own inlet glyph draws, for a power inlet or outlet here. */
function hexPoints(x: number, y: number, w: number, h: number): string {
  const cut = Math.min(w, h) * 0.3;
  return [
    [x + cut, y],
    [x + w - cut, y],
    [x + w, y + cut],
    [x + w, y + h - cut],
    [x + w - cut, y + h],
    [x + cut, y + h],
    [x, y + h - cut],
    [x, y + cut],
  ]
    .map((p) => p.join(','))
    .join(' ');
}

/** One faceplate's worth of port glyphs — filled when cabled/fed, hollow
 * when free, ink either way (UI-SPEC "Ports": never a sheath). */
function PortGlyphs({ glyphs }: { glyphs: readonly FaceplateGlyph[] }) {
  return (
    <>
      {glyphs.map((g) => {
        const cls = `print-elevation__port ${g.port.cable != null ? 'print-elevation__port--cabled' : 'print-elevation__port--free'}`;
        return g.shape === 'hex' ? (
          <polygon key={g.port.id} points={hexPoints(g.x, g.y, g.w, g.h)} className={cls} />
        ) : (
          <rect key={g.port.id} x={g.x} y={g.y} width={g.w} height={g.h} className={cls} />
        );
      })}
    </>
  );
}

function Elevation({
  items,
  heightU,
  unitNumbering,
  rowMm,
  elevation,
  blackAndWhite,
  cableLines,
}: {
  items: readonly ElevationItem[];
  heightU: number;
  unitNumbering: string;
  rowMm: number;
  elevation: Facing;
  blackAndWhite: boolean;
  cableLines: readonly ElevationCableLine[];
}) {
  const railW = 8;
  const bodyW = 70;
  const width = railW * 2 + bodyW;
  const captionH = ELEVATION_CAPTION_MM;
  const bodyHeight = heightU * rowMm;
  const height = bodyHeight + captionH;
  const byId = new Map(items.filter((i) => i.kind === 'chassis').map((i) => [i.chassis.id, i] as const));
  const hatchId = `print-hatch-${elevation}`;

  function yOf(positionU: number, itemHeightU: number): number {
    return (heightU - (positionU + itemHeightU - 1)) * rowMm;
  }

  // One layout per chassis, reused below for both the boxes and the cable
  // curves' own anchors (a port's glyph, never a device's bare centre).
  const layoutByChassisId = new Map<string, ReturnType<typeof deviceFaceplateLayout>>();
  const portXY = new Map<string, { x: number; y: number }>();
  for (const item of items) {
    if (item.kind !== 'chassis') continue;
    const y = yOf(item.positionU, item.heightU);
    const c = item.chassis;
    const face = faceplateItem(c, elevation);
    const layout = deviceFaceplateLayout(c.hostname || '—', c.model, face.ports, face.inlets, item.heightU, bodyW);
    layoutByChassisId.set(c.id, layout);
    for (const g of [...layout.portGlyphs, ...layout.inletGlyphs]) {
      portXY.set(g.port.id, { x: railW + g.x + g.w / 2, y: y + g.y + g.h / 2 });
    }
  }

  const empties = emptyUnitRows(
    heightU,
    items.map((i) => (i.kind === 'chassis' ? i.chassis : i.shelf)),
  );

  return (
    <svg
      className="print-elevation"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height: `${height}mm` }}
      data-testid={`print-elevation-${elevation}`}
    >
      <defs>
        <pattern id={hatchId} width="2" height="2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="2" className="print-elevation__hatch-line" />
        </pattern>
      </defs>
      <text x={width / 2} y={captionH - 1} textAnchor="middle" className="print-elevation__caption">
        {elevation === 'front' ? 'FRONT' : 'REAR'}
      </text>
      <g transform={`translate(0, ${captionH})`}>
        <rect x={0.25} y={0.25} width={width - 0.5} height={bodyHeight - 0.5} className="print-elevation__frame" />
        {empties.map((r) => (
          <rect key={`empty-${r}`} x={railW} y={r * rowMm} width={bodyW} height={rowMm} fill={`url(#${hatchId})`} data-testid={`print-elevation-${elevation}-empty`} />
        ))}
        {Array.from({ length: heightU }, (_, r) => {
          const positionU = heightU - r;
          const label = unitLabelOf(heightU, unitNumbering, positionU);
          const y = r * rowMm + rowMm / 2 + 1;
          return (
            <g key={r}>
              <text x={railW - 1} y={y} textAnchor="end" className="print-elevation__unit">
                {label}
              </text>
              <text x={width - railW + 1} y={y} textAnchor="start" className="print-elevation__unit">
                {label}
              </text>
            </g>
          );
        })}
        {items.map((item) => {
          const y = yOf(item.positionU, item.heightU);
          const h = item.heightU * rowMm;
          const clipId = `print-clip-${elevation}-${item.kind === 'chassis' ? item.chassis.id : item.shelf.id}`;
          if (item.kind === 'chassis') {
            const c = item.chassis;
            const layout = layoutByChassisId.get(c.id)!;
            return (
              <g key={c.id} transform={`translate(${railW}, ${y})`}>
                <clipPath id={clipId}>
                  <rect width={bodyW} height={h} />
                </clipPath>
                {/* A name or model longer than its own estimate still stops at
                    the same edge the layout reserved — never over a glyph. */}
                <clipPath id={`${clipId}-name`}>
                  <rect x={layout.nameBox.x0} width={layout.nameBox.x1 - layout.nameBox.x0} height={h} />
                </clipPath>
                <clipPath id={`${clipId}-model`}>
                  <rect x={layout.modelBox.x0} width={layout.modelBox.x1 - layout.modelBox.x0} height={h} />
                </clipPath>
                <rect width={bodyW} height={h} className="print-elevation__box" />
                <g clipPath={`url(#${clipId})`}>
                  <PortGlyphs glyphs={layout.portGlyphs} />
                  <PortGlyphs glyphs={layout.inletGlyphs} />
                  <text x={2} y={layout.nameY} className="print-elevation__name" clipPath={`url(#${clipId}-name)`}>
                    {c.hostname || '—'}
                  </text>
                  <text x={layout.modelX} y={layout.modelY} textAnchor="end" className="print-elevation__model" clipPath={`url(#${clipId}-model)`}>
                    {c.model}
                  </text>
                </g>
              </g>
            );
          }
          const names = item.occupants.map((o) => o.label || '—').join(', ');
          return (
            <g key={item.shelf.id} transform={`translate(${railW}, ${y})`}>
              <clipPath id={clipId}>
                <rect width={bodyW} height={h} />
              </clipPath>
              <rect width={bodyW} height={h} className="print-elevation__shelf" />
              <g clipPath={`url(#${clipId})`}>
                <text x={2} y={rowMm - 1.6} className="print-elevation__name">
                  {item.shelf.label}
                </text>
                <text x={2} y={Math.min(h - 0.6, rowMm * 2 - 1.6)} className="print-elevation__model">
                  {names}
                </text>
              </g>
            </g>
          );
        })}
        {cableLines.map((line) => {
          const a = byId.get(line.fromChassisId);
          const b = byId.get(line.toChassisId);
          if (!a || a.kind !== 'chassis' || !b || b.kind !== 'chassis') return null;
          const fallbackA = { x: railW + bodyW / 2, y: yOf(a.positionU, a.heightU) + (a.heightU * rowMm) / 2 };
          const fallbackB = { x: railW + bodyW / 2, y: yOf(b.positionU, b.heightU) + (b.heightU * rowMm) / 2 };
          const pa = portXY.get(line.fromPortId) ?? fallbackA;
          const pb = portXY.get(line.toPortId) ?? fallbackB;
          const c1y = pa.y + (pb.y - pa.y) * 0.4;
          const c2y = pa.y + (pb.y - pa.y) * 0.6;
          const stroke = blackAndWhite ? undefined : line.sheath ? `var(--sheath-${line.sheath})` : undefined;
          return (
            <g key={line.cableId}>
              <path
                d={`M ${pa.x} ${pa.y} C ${pa.x} ${c1y}, ${pb.x} ${c2y}, ${pb.x} ${pb.y}`}
                className={blackAndWhite ? 'print-elevation__cable print-elevation__cable--bw' : 'print-elevation__cable'}
                style={stroke ? { stroke } : undefined}
              />
              {blackAndWhite && line.sheath && (
                <text x={(pa.x + pb.x) / 2 + 1.5} y={(pa.y + pb.y) / 2} className="print-elevation__cable-label">
                  {line.sheath}
                </text>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
