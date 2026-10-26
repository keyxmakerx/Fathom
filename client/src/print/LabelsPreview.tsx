// Print labels: the ticked rows of an Inventory list as labels with a QR code (ADR-0075). One label
// per page for a tape or roll printer, thirty to an A4 sheet with cut lines. The preview is the print:
// what is on screen is what the browser sends to the printer's driver.

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import type { InvRow } from '../components/inventory/kinds';
import { QR_QUIET_ZONE, encodeQr, qrPath, qrSide } from '../qr';
import { LABEL_PRESETS, DEFAULT_PRESET, labelItems, pagesOf, presetOf, type LabelItem, type LabelListKind, type LabelPreset, type LabelPresetId } from './labels';
import './labels.css';

const PRESET_KEY = 'fathom-label-preset';

function savedPreset(): LabelPresetId {
  try {
    const v = localStorage.getItem(PRESET_KEY);
    return LABEL_PRESETS.some((p) => p.id === v) ? (v as LabelPresetId) : DEFAULT_PRESET;
  } catch {
    return DEFAULT_PRESET;
  }
}

export interface LabelsPreviewProps {
  kind: LabelListKind;
  rows: readonly InvRow[];
  designId: string;
  onClose(): void;
}

export function LabelsPreview({ kind, rows, designId, onClose }: LabelsPreviewProps) {
  const [presetId, setPresetId] = useState<LabelPresetId>(savedPreset);
  const preset = presetOf(presetId);
  const items = useMemo(() => labelItems(kind, rows, window.location.origin, designId), [kind, rows, designId]);
  const pages = useMemo(() => pagesOf(items, preset), [items, preset]);

  // While this is open, printing prints only the labels (`labels.css`).
  useEffect(() => {
    document.body.classList.add('labels-open');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.classList.remove('labels-open');
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const choose = (id: LabelPresetId) => {
    setPresetId(id);
    try {
      localStorage.setItem(PRESET_KEY, id);
    } catch {
      // the choice just is not remembered
    }
  };

  return createPortal(
    <div className="labels-preview" role="dialog" aria-modal="true" aria-label="Print labels">
      <div className="labels-preview__bar">
        <b>
          {items.length.toLocaleString('en-GB')} label{items.length === 1 ? '' : 's'}
        </b>
        <label>
          <span>Labels</span>
          <select value={presetId} onChange={(e) => choose(e.currentTarget.value as LabelPresetId)}>
            {LABEL_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <span className="labels-preview__grow" />
        <button type="button" className="btn-main" onClick={() => window.print()} disabled={items.length === 0}>
          Print
        </button>
        <button type="button" className="btn-quiet" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="labels-preview__help">
        {kind === 'cables' ? 'Two labels per cable, one for each end. ' : ''}
        In the print dialog, pick the printer and the same label size, with margins set to none. Each code opens the item in
        Fathom after sign-in; it holds a link and the item's id, and nothing else about your network.
        {preset.note ? ` ${preset.note}` : ''}
      </p>
      <div className="labels-preview__pages">
        {pages.map((page, i) => (
          <LabelPage key={i} page={page} preset={preset} />
        ))}
      </div>
    </div>,
    document.body,
  );
}

function LabelPage({ page, preset }: { page: readonly LabelItem[]; preset: LabelPreset }) {
  const w = preset.sheet?.widthMm ?? preset.widthMm;
  const h = preset.sheet?.heightMm ?? preset.heightMm;
  return (
    <div className={`labels-page labels-page--${preset.id}`} style={{ width: `${w}mm`, height: `${h}mm` }}>
      {page.map((item) => (
        <Label key={item.key} item={item} preset={preset} />
      ))}
    </div>
  );
}

function Label({ item, preset }: { item: LabelItem; preset: LabelPreset }) {
  const drawn = useMemo(() => {
    const symbol = encodeQr(item.link);
    return { side: qrSide(symbol.size), path: qrPath(symbol.modules, QR_QUIET_ZONE) };
  }, [item.link]);
  const pad = 2;
  const qr = preset.heightMm - pad * 2;
  return (
    <div className={preset.sheet ? 'label label--cut' : 'label'} style={{ width: `${preset.widthMm}mm`, height: `${preset.heightMm}mm`, padding: `${pad}mm`, gap: `${pad}mm` }}>
      <svg className="label__qr" viewBox={`0 0 ${drawn.side} ${drawn.side}`} shapeRendering="crispEdges" style={{ width: `${qr}mm`, height: `${qr}mm` }} role="img" aria-label={`Code for ${item.title}`}>
        <rect x="0" y="0" width={drawn.side} height={drawn.side} fill="#FFFFFF" />
        <path d={drawn.path} fill="#000000" />
      </svg>
      <span className="label__text">
        <b style={{ fontSize: `${Math.min(6, preset.heightMm * 0.26)}mm` }}>{item.title}</b>
        {item.detail && <span style={{ fontSize: `${Math.min(3.2, preset.heightMm * 0.15)}mm` }}>{item.detail}</span>}
      </span>
    </div>
  );
}
