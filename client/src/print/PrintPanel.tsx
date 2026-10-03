import { useEffect, useMemo, useRef, useState } from 'react';

import { PageCounter } from './PrintPreview';
import { PRINT_SECTIONS, type CablesOption, type PrintJob, type PrintOptions, type PrintSection, type RackScope } from './printJob';
import type { PaperSize } from './paper';
import { PAPER_SIZE_NAMES } from './paper';
import './print.css';

export interface PrintPanelProps {
  /** The design's name, for the panel's title. */
  designName: string;
  /** Builds the job for the ticked rows. `viewPng` is the canvas picture, or `null` when not taken. */
  buildJob: (sections: ReadonlySet<PrintSection>, options: PrintOptions, viewPng: string | null) => PrintJob;
  /** The canvas is on screen, so "This view" can be taken. */
  hasView: boolean;
  /** The Inventory table's rows can be printed (the Inventory page is open). */
  hasInventory: boolean;
  /** The Cables list is filtering, so "as shown on screen" differs from "all". */
  cablesFiltered: boolean;
  rackCount: number;
  /** Takes the canvas picture; resolves `null` when there is no drawing on screen. */
  captureView: (blackAndWhite: boolean) => Promise<string | null>;
  onPrint: (job: PrintJob) => void;
  onSavePng: (dataUrl: string) => void;
  onCancel: () => void;
  onDownloadXlsx: () => void;
  onDownloadCsv: () => void;
}

const LABEL: Record<PrintSection, string> = {
  view: 'This view',
  racks: 'Rack elevations, front and back',
  cables: 'Cable schedule: each cable, both ends, label',
  ports: 'Port map per device',
  inventory: 'Inventory table, with your columns',
};

/** The page list (r10-print B): tick the pages, see how many each runs to, make one PDF.
 * Not a `Popover`: every row here is a live form control, not a menu row that closes on click. */
export function PrintPanel({
  designName,
  buildJob,
  hasView,
  hasInventory,
  cablesFiltered,
  rackCount,
  captureView,
  onPrint,
  onSavePng,
  onCancel,
  onDownloadXlsx,
  onDownloadCsv,
}: PrintPanelProps) {
  const available = useMemo(
    () =>
      PRINT_SECTIONS.filter((id) => (id === 'view' ? hasView : id === 'inventory' ? hasInventory : id === 'racks' ? rackCount > 0 : true)),
    [hasView, hasInventory, rackCount],
  );
  const [ticked, setTicked] = useState<ReadonlySet<PrintSection>>(
    () => new Set<PrintSection>(['view', 'racks', 'cables'].filter((id) => available.includes(id as PrintSection)) as PrintSection[]),
  );
  const [paper, setPaper] = useState<PaperSize>('A4');
  const [rackScope, setRackScope] = useState<RackScope>('all');
  const [cables, setCables] = useState<CablesOption>('all');
  const [hideSensitive, setHideSensitive] = useState(false);
  const [blackAndWhite, setBlackAndWhite] = useState(true);
  const [counts, setCounts] = useState<Partial<Record<PrintSection, number>>>({});
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Focus enters the panel on open and returns to whatever opened it on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)')?.focus();
    return () => opener?.focus?.();
  }, []);

  const options: PrintOptions = { paper, rackScope, cables, hideSensitive, blackAndWhite };
  const optionsKey = `${paper}|${rackScope}|${cables}|${hideSensitive}|${blackAndWhite}`;
  // Counts are measured from every available row, so ticking never re-measures.
  const countJob = useMemo(
    () => buildJob(new Set(available), options, ''),
    [buildJob, available, optionsKey], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const total = available.filter((id) => ticked.has(id)).reduce((sum, id) => sum + (counts[id] ?? 0), 0);

  function toggle(id: PrintSection) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function makePdf() {
    if (busy || total === 0) return;
    setBusy(true);
    setFailed(null);
    try {
      const sections = new Set(available.filter((id) => ticked.has(id)));
      let viewPng: string | null = null;
      if (sections.has('view')) {
        viewPng = await captureView(blackAndWhite);
        if (viewPng == null) sections.delete('view');
      }
      onPrint(buildJob(sections, options, viewPng));
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'The pages could not be made.');
    } finally {
      setBusy(false);
    }
  }

  async function savePng() {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    try {
      const png = await captureView(blackAndWhite);
      if (png == null) setFailed('There is no drawing on screen to save.');
      else onSavePng(png);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'The picture could not be made.');
    } finally {
      setBusy(false);
    }
  }

  // Escape cancels; Ctrl+P here makes the PDF rather than falling through to
  // the browser's, which would print the live drawing.
  const makeRef = useRef(makePdf);
  makeRef.current = makePdf;
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        void makeRef.current();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel]);

  return (
    <div className="print-panel" role="dialog" aria-labelledby="print-panel-title" data-testid="print-panel" ref={panelRef}>
      <PageCounter job={countJob} onCounts={setCounts} />
      <div className="print-panel__head">
        <span id="print-panel-title" className="print-panel__title">Print a pack · {designName}</span>
      </div>

      <table className="print-panel__pages" data-testid="print-pages">
        <thead>
          <tr>
            <th scope="col">Page</th>
            <th scope="col" className="print-panel__count">
              Pages
            </th>
          </tr>
        </thead>
        <tbody>
          {PRINT_SECTIONS.map((id) => {
            const enabled = available.includes(id);
            return (
              <tr key={id}>
                <td>
                  <label className="print-panel__check">
                    <input
                      type="checkbox"
                      checked={enabled && ticked.has(id)}
                      disabled={!enabled}
                      onChange={() => toggle(id)}
                      data-testid={`print-section-${id}`}
                    />
                    <span>
                      {LABEL[id]}
                      {!enabled && id === 'view' && <span className="print-panel__hint-block">open the canvas to print its view</span>}
                      {!enabled && id === 'racks' && <span className="print-panel__hint-block">no rack yet</span>}
                      {!enabled && id === 'inventory' && <span className="print-panel__hint-block">open Inventory to print its table</span>}
                    </span>
                  </label>
                </td>
                <td className="print-panel__count" data-testid={`print-count-${id}`}>
                  {enabled ? (counts[id] ?? '…') : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="print-panel__row">
        <span className="print-panel__section-label print-panel__section-label--inline">Paper</span>
        {PAPER_SIZE_NAMES.map((size) => (
          <button
            key={size}
            type="button"
            aria-pressed={paper === size}
            className={paper === size ? 'print-panel__chip print-panel__chip--on' : 'print-panel__chip'}
            onClick={() => setPaper(size)}
            data-testid={`print-paper-${size.toLowerCase()}`}
          >
            {size}
          </button>
        ))}
      </div>

      {ticked.has('racks') && rackCount > 1 && (
        <div className="print-panel__row">
          <span className="print-panel__section-label print-panel__section-label--inline">Racks</span>
          <button type="button" aria-pressed={rackScope === 'all'} className={rackScope === 'all' ? 'print-panel__chip print-panel__chip--on' : 'print-panel__chip'} onClick={() => setRackScope('all')} data-testid="print-racks-all">
            Every rack
          </button>
          <button type="button" aria-pressed={rackScope === 'active'} className={rackScope === 'active' ? 'print-panel__chip print-panel__chip--on' : 'print-panel__chip'} onClick={() => setRackScope('active')} data-testid="print-racks-active">
            This rack
          </button>
        </div>
      )}

      {ticked.has('racks') && (
        <div className="print-panel__row">
          <span className="print-panel__section-label print-panel__section-label--inline">Cables on elevations</span>
          <button type="button" aria-pressed={cables === 'none'} className={cables === 'none' ? 'print-panel__chip print-panel__chip--on' : 'print-panel__chip'} onClick={() => setCables('none')} data-testid="print-cables-none">
            None
          </button>
          <button type="button" aria-pressed={cables === 'all'} className={cables === 'all' ? 'print-panel__chip print-panel__chip--on' : 'print-panel__chip'} onClick={() => setCables('all')} data-testid="print-cables-all">
            All
          </button>
          {cablesFiltered && (
            <button type="button" aria-pressed={cables === 'screen'} className={cables === 'screen' ? 'print-panel__chip print-panel__chip--on' : 'print-panel__chip'} onClick={() => setCables('screen')} data-testid="print-cables-screen">
              As shown on screen
            </button>
          )}
        </div>
      )}

      <label className="print-panel__check">
        <input type="checkbox" checked={hideSensitive} onChange={(e) => setHideSensitive(e.target.checked)} data-testid="print-hide-sensitive" />
        <span>
          Leave out serial numbers and management addresses
          <span className="print-panel__hint-block">printed as a dash, with a note saying so</span>
        </span>
      </label>
      <label className="print-panel__check">
        <input type="checkbox" checked={blackAndWhite} onChange={(e) => setBlackAndWhite(e.target.checked)} data-testid="print-black-and-white" />
        <span>
          Black and white
          <span className="print-panel__hint-block">cable colours also written as words</span>
        </span>
      </label>

      <p className="print-panel__note">Every page carries the design, date, who printed it and page numbers. Made in your browser.</p>

      {ticked.has('ports') && (
        <div className="print-panel__row print-panel__row--download">
          <span className="print-panel__section-label print-panel__section-label--inline">Port map as spreadsheet</span>
          <button type="button" className="print-panel__chip" onClick={onDownloadXlsx} data-testid="print-download-xlsx">
            .xlsx
          </button>
          <button type="button" className="print-panel__chip" onClick={onDownloadCsv} data-testid="print-download-csv">
            .csv
          </button>
        </div>
      )}

      {failed != null && (
        <p className="print-panel__note" role="alert" data-testid="print-failed">
          {failed}
        </p>
      )}

      <div className="print-panel__actions">
        <button type="button" className="print-panel__print" onClick={() => void makePdf()} disabled={busy || total === 0} data-testid="print-panel-print">
          Make PDF · {total} page{total === 1 ? '' : 's'}
        </button>
        {hasView && (
          <button type="button" className="print-panel__cancel" onClick={() => void savePng()} disabled={busy} data-testid="print-save-png">
            Save this view as PNG
          </button>
        )}
        <button type="button" className="print-panel__cancel" onClick={onCancel} data-testid="print-panel-cancel">
          Cancel
        </button>
      </div>
    </div>
  );
}
