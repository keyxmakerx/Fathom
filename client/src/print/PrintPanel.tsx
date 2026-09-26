import { useEffect, useRef, useState } from 'react';

import type { CablesOption, PrintOptions, PrintWhat } from './printJob';
import type { PaperSize } from './paper';
import { PAPER_SIZE_NAMES } from './paper';
import './print.css';

export interface PrintPanelRackSummary {
  id: string;
  label: string;
  heightU: number;
}

export interface PrintPanelProps {
  /** The rack selected on screen, falling back to the first rack — brief
   * item 1. `null` when the closet has no rack at all (nothing to print as
   * "this rack"). */
  activeRack: PrintPanelRackSummary | null;
  rackCount: number;
  onPrint: (what: PrintWhat, options: PrintOptions) => void;
  onCancel: () => void;
  onDownloadXlsx: () => void;
  onDownloadCsv: () => void;
}

/**
 * The Print button/Ctrl+P panel — brief item 1: what to print, paper,
 * cables, and the leave-out/black-and-white options. Not a `Popover`: every
 * row here is a live form control a click must not close the box over, the
 * way `PopoverRow`'s own close-on-select does.
 */
export function PrintPanel({ activeRack, rackCount, onPrint, onCancel, onDownloadXlsx, onDownloadCsv }: PrintPanelProps) {
  const [what, setWhat] = useState<PrintWhat>(activeRack != null ? 'this-rack' : 'closet');
  const [paper, setPaper] = useState<PaperSize>('A4');
  const [cables, setCables] = useState<CablesOption>('none');
  const [hideSensitive, setHideSensitive] = useState(false);
  const [blackAndWhite, setBlackAndWhite] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  function commit() {
    onPrint(what, { paper, cables, hideSensitive, blackAndWhite });
  }

  // Escape cancels; Ctrl+P here runs this panel's own Print rather than
  // falling through to the browser's, which would print the live drawing.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        commit();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `commit` reads
    // the latest state via closure each render; re-binding every render is
    // fine here (one listener, no accumulation) and simpler than a ref.
  }, [onCancel, what, paper, cables, hideSensitive, blackAndWhite]);

  return (
    <div className="print-panel" role="dialog" aria-label="Print" data-testid="print-panel" ref={panelRef}>
      <div className="print-panel__head">
        <span className="print-panel__title">Print</span>
      </div>

      <div className="print-panel__section-label">What</div>
      <label className="print-panel__option">
        <input
          type="radio"
          name="print-what"
          checked={what === 'this-rack'}
          disabled={activeRack == null}
          onChange={() => setWhat('this-rack')}
          data-testid="print-what-this-rack"
        />
        <span>This rack</span>
        <span className="print-panel__hint">{activeRack ? `${activeRack.label} · ${activeRack.heightU}U` : 'no rack yet'}</span>
      </label>
      <label className="print-panel__option">
        <input
          type="radio"
          name="print-what"
          checked={what === 'closet'}
          disabled={rackCount === 0}
          onChange={() => setWhat('closet')}
          data-testid="print-what-closet"
        />
        <span>Every rack in this closet</span>
        <span className="print-panel__hint">{rackCount} rack{rackCount === 1 ? '' : 's'}</span>
      </label>
      <label className="print-panel__option">
        <input
          type="radio"
          name="print-what"
          checked={what === 'cut-sheet'}
          onChange={() => setWhat('cut-sheet')}
          data-testid="print-what-cut-sheet"
        />
        <span>The cut sheet</span>
        <span className="print-panel__hint">every device, every port</span>
      </label>

      <div className="print-panel__row">
        <span className="print-panel__section-label print-panel__section-label--inline">Paper</span>
        {PAPER_SIZE_NAMES.map((size) => (
          <button
            key={size}
            type="button"
            className={paper === size ? 'print-panel__chip print-panel__chip--on' : 'print-panel__chip'}
            onClick={() => setPaper(size)}
            data-testid={`print-paper-${size.toLowerCase()}`}
          >
            {size}
          </button>
        ))}
      </div>

      {what !== 'cut-sheet' && (
        <div className="print-panel__row">
          <span className="print-panel__section-label print-panel__section-label--inline">Cables</span>
          <button
            type="button"
            className={cables === 'none' ? 'print-panel__chip print-panel__chip--on' : 'print-panel__chip'}
            onClick={() => setCables('none')}
            data-testid="print-cables-none"
          >
            None
          </button>
          <button
            type="button"
            className={cables === 'all' ? 'print-panel__chip print-panel__chip--on' : 'print-panel__chip'}
            onClick={() => setCables('all')}
            data-testid="print-cables-all"
          >
            All
          </button>
          <button type="button" className="print-panel__chip print-panel__chip--future" disabled>
            As filtered on screen
          </button>
        </div>
      )}

      <div className="print-panel__section-label">Options</div>
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

      {what === 'cut-sheet' && (
        <div className="print-panel__row print-panel__row--download">
          <span className="print-panel__section-label print-panel__section-label--inline">Download as spreadsheet</span>
          <button type="button" className="print-panel__chip" onClick={onDownloadXlsx} data-testid="print-download-xlsx">
            .xlsx
          </button>
          <button type="button" className="print-panel__chip" onClick={onDownloadCsv} data-testid="print-download-csv">
            .csv
          </button>
        </div>
      )}

      <div className="print-panel__actions">
        <button type="button" className="print-panel__print" onClick={commit} data-testid="print-panel-print">
          Print
        </button>
        <button type="button" className="print-panel__cancel" onClick={onCancel} data-testid="print-panel-cancel">
          Cancel
        </button>
      </div>
    </div>
  );
}
