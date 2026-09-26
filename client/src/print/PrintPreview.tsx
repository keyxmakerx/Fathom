import { useEffect } from 'react';

import type { ChassisView } from '../document/view';
import { unitLabel } from './units';
import { pageHeightMm, pageWidthMm, type PaperSize } from './paper';
import { ELEVATION_ROW_MM, type ElevationCableLine } from './rackSheet';
import type { CutSheetTableRow } from './cutSheetTable';
import type { PrintPage } from './printJob';
import type { Facing } from '../components/drawing/elevation';
import './print.css';

export interface PrintPreviewProps {
  pages: readonly PrintPage[];
  paper: PaperSize;
  blackAndWhite: boolean;
  onClose: () => void;
}

/** The panel's own "Print" click lands here: page-sized blocks, laid out in
 * normal document flow, each with its own title block and page number —
 * brief item 2's answer to Firefox ignoring `@page size` in a saved PDF.
 * Ctrl+P here prints; elsewhere in the app it opens the panel instead
 * (`PrintPanel.tsx`'s own caller). */
export function PrintPreview({ pages, paper, blackAndWhite, onClose }: PrintPreviewProps) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const inField = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (inField) return; // brief item 1: "Ctrl+P is left alone while focus is in a text field"
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        window.print();
      }
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return (
    <div className="print-preview" data-testid="print-preview">
      <div className="print-preview__bar no-print">
        <span>
          {pages.length} page{pages.length === 1 ? '' : 's'} {'·'} {paper} {'·'} Save as PDF is in the print dialog
        </span>
        <button type="button" onClick={() => window.print()} data-testid="print-preview-print">
          Print
        </button>
        <button type="button" onClick={onClose} data-testid="print-preview-close">
          Close
        </button>
      </div>
      <div className="print-preview__pages">
        {pages.map((page, i) => (
          <Page key={i} page={page} paper={paper} blackAndWhite={blackAndWhite} />
        ))}
      </div>
    </div>
  );
}

function Page({ page, paper, blackAndWhite }: { page: PrintPage; paper: PaperSize; blackAndWhite: boolean }) {
  const w = pageWidthMm(paper);
  const h = pageHeightMm(paper);
  return (
    <div className="print-page" style={{ width: `${w}mm`, height: `${h}mm` }} data-testid="print-page">
      <div className="print-page__header">{page.titleBlock.sheetLabel}</div>
      <div className="print-page__content">
        {page.content.kind === 'rack' ? (
          <RackSheetContent content={page.content} blackAndWhite={blackAndWhite} />
        ) : (
          <CutSheetContent rows={page.content.rows} />
        )}
      </div>
      <TitleBlock titleBlock={page.titleBlock} />
    </div>
  );
}

function TitleBlock({ titleBlock }: { titleBlock: PrintPage['titleBlock'] }) {
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

function Elevation({
  chassis,
  fromRow,
  toRow,
  heightU,
  unitNumbering,
  elevation,
  blackAndWhite,
  cableLines,
}: {
  chassis: readonly ChassisView[];
  fromRow: number;
  toRow: number;
  heightU: number;
  unitNumbering: string;
  elevation: Facing;
  blackAndWhite: boolean;
  cableLines: readonly ElevationCableLine[];
}) {
  const rows = toRow - fromRow + 1;
  const railW = 8;
  const bodyW = 70;
  const width = railW * 2 + bodyW;
  const height = rows * ELEVATION_ROW_MM;
  const byId = new Map(chassis.map((c) => [c.id, c] as const));

  function yOf(c: ChassisView): number {
    const top = heightU - (c.positionU + c.heightU - 1) - fromRow;
    return top * ELEVATION_ROW_MM;
  }

  return (
    <svg
      className="print-elevation"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height: `${height}mm` }}
      data-testid={`print-elevation-${elevation}`}
    >
      <text x={width / 2} y={-1} textAnchor="middle" className="print-elevation__caption">
        {elevation === 'front' ? 'FRONT' : 'REAR'}
      </text>
      <rect x={0.25} y={0.25} width={width - 0.5} height={height - 0.5} className="print-elevation__frame" />
      {Array.from({ length: rows }, (_, r) => {
        const positionU = heightU - (fromRow + r);
        const label = unitLabel(heightU, unitNumbering, positionU);
        const y = r * ELEVATION_ROW_MM;
        return (
          <text key={r} x={railW - 1} y={y + ELEVATION_ROW_MM / 2 + 1} textAnchor="end" className="print-elevation__unit">
            {label}
          </text>
        );
      })}
      {chassis.map((c) => (
        <g key={c.id} transform={`translate(${railW}, ${yOf(c)})`}>
          <rect width={bodyW} height={c.heightU * ELEVATION_ROW_MM} className="print-elevation__box" />
          <text x={2} y={ELEVATION_ROW_MM - 1.6} className="print-elevation__name">
            {c.hostname || '—'}
          </text>
          <text x={bodyW - 2} y={ELEVATION_ROW_MM - 1.6} textAnchor="end" className="print-elevation__model">
            {c.model}
          </text>
        </g>
      ))}
      {cableLines.map((line) => {
        const a = byId.get(line.fromChassisId);
        const b = byId.get(line.toChassisId);
        if (!a || !b) return null;
        const ax = railW + bodyW / 2;
        const ay = yOf(a) + (a.heightU * ELEVATION_ROW_MM) / 2;
        const bx = railW + bodyW / 2;
        const by = yOf(b) + (b.heightU * ELEVATION_ROW_MM) / 2;
        const stroke = blackAndWhite ? undefined : line.sheath ? `var(--sheath-${line.sheath})` : undefined;
        return (
          <g key={line.cableId}>
            <path
              d={`M ${ax} ${ay} L ${bx} ${by}`}
              className={blackAndWhite ? 'print-elevation__cable print-elevation__cable--bw' : 'print-elevation__cable'}
              style={stroke ? { stroke } : undefined}
            />
            {/* Black and white: the line alone no longer says the colour, so
                the word does — brief item 1. */}
            {blackAndWhite && line.sheath && (
              <text x={(ax + bx) / 2 + 1.5} y={(ay + by) / 2} className="print-elevation__cable-label">
                {line.sheath}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function RackSheetContent({
  content,
  blackAndWhite,
}: {
  content: Extract<PrintPage['content'], { kind: 'rack' }>;
  blackAndWhite: boolean;
}) {
  return (
    <div className="print-rack-sheet">
      <div className="print-rack-sheet__elevations">
        <Elevation
          chassis={content.chassis}
          fromRow={content.fromRow}
          toRow={content.toRow}
          heightU={content.heightU}
          unitNumbering={content.unitNumbering}
          elevation="front"
          blackAndWhite={blackAndWhite}
          cableLines={content.frontCables}
        />
        <Elevation
          chassis={content.chassis}
          fromRow={content.fromRow}
          toRow={content.toRow}
          heightU={content.heightU}
          unitNumbering={content.unitNumbering}
          elevation="rear"
          blackAndWhite={blackAndWhite}
          cableLines={content.rearCables}
        />
      </div>
      <table className="print-table" data-testid="print-rack-device-table">
        <thead>
          <tr>
            <th>Unit</th>
            <th>Name</th>
            <th>Model</th>
            <th>Serial</th>
            <th>Management address</th>
            <th>Ports cabled</th>
          </tr>
        </thead>
        <tbody>
          {content.deviceRows.map((row, i) => (
            <tr key={i}>
              <td>{row.unit}</td>
              <td className="print-table__bold">{row.name}</td>
              <td>{row.model}</td>
              <td>{row.serial}</td>
              <td>{row.managementAddress}</td>
              <td>{row.portsCabled}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {content.hideSensitive && <div className="print-note">Serial numbers and management addresses left out of this printout.</div>}
    </div>
  );
}

function CutSheetContent({ rows }: { rows: readonly CutSheetTableRow[] }) {
  return (
    <table className="print-table print-table--cutsheet" data-testid="print-cutsheet-table">
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className={row.bold ? 'print-table__bold' : undefined}>
            {row.cells.map((cell, j) => (
              <td key={j}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
