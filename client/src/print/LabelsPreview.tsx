// Print labels: the ticked rows of an Inventory list as labels with a QR code (ADR-0075). One label
// per page for a tape or roll printer, thirty to an A4 sheet with cut lines; for cables, a wrap or a
// flag sized to the cable. The preview is the print: what is on screen is what the browser sends to
// the printer's driver.

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { QR_QUIET_ZONE, encodeQr, qrPath, qrSide } from '../qr';
import {
  CABLE_THICKNESS,
  DEFAULT_CABLE_PRESET,
  DEFAULT_PRESET,
  DEFAULT_THICKNESS,
  FLAG_FACE_MM,
  pageNameOf,
  pagesOf,
  presetOf,
  presetsFor,
  wrapColumns,
  type CableThicknessId,
  type LabelItem,
  type LabelPreset,
  type LabelPresetId,
} from './labels';
import './labels.css';
import { readPref, writePref } from '../prefs';

// Cables keep their own choice, so a wrap picked for cables is not what a rack's label opens with.
const PRESET_KEY = 'fathom-label-preset';
const CABLE_PRESET_KEY = 'fathom-cable-label-preset';
const THICKNESS_KEY = 'fathom-cable-thickness';

function saved<T extends string>(key: string, allowed: readonly string[], fallback: T): T {
  const v = readPref(key);
  return v != null && allowed.includes(v) ? (v as T) : fallback;
}

export interface LabelsPreviewProps {
  items: readonly LabelItem[];
  /** A line before the printing help, such as why there are two labels per cable. */
  note?: string;
  /** Labels for cables: a wrap or a flag is offered, and wraps are the default. */
  cables?: boolean;
  onClose(): void;
}

export function LabelsPreview({ items, note, cables = false, onClose }: LabelsPreviewProps) {
  const offered = presetsFor(cables);
  const presetKey = cables ? CABLE_PRESET_KEY : PRESET_KEY;
  const [presetId, setPresetId] = useState<LabelPresetId>(() =>
    saved(presetKey, offered.map((p) => p.id), cables ? DEFAULT_CABLE_PRESET : DEFAULT_PRESET),
  );
  const [thickness, setThickness] = useState<CableThicknessId>(() =>
    saved(THICKNESS_KEY, CABLE_THICKNESS.map((t) => t.id), DEFAULT_THICKNESS),
  );
  const preset = presetOf(presetId, thickness);
  const pageName = pageNameOf(presetId, thickness);
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
    writePref(presetKey, id);
  };
  const chooseThickness = (id: CableThicknessId) => {
    setThickness(id);
    writePref(THICKNESS_KEY, id);
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
            {offered.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {preset.shape !== 'flat' ? (
          <label>
            <span>Cable</span>
            <select value={thickness} onChange={(e) => chooseThickness(e.currentTarget.value as CableThicknessId)}>
              {CABLE_THICKNESS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <span className="labels-preview__grow" />
        <button type="button" className="btn-main" onClick={() => window.print()} disabled={items.length === 0}>
          Print
        </button>
        <button type="button" className="btn-quiet" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="labels-preview__help">
        {note ? `${note} ` : ''}
        In the print dialog, pick the printer and the same label size ({preset.widthMm} × {preset.heightMm} mm), with margins set to
        none. Each code opens the item in
        Fathom after sign-in; it holds a link and the item's id, and nothing else about your network.
        {preset.note ? ` ${preset.note}` : ''}
      </p>
      <div className="labels-preview__pages">
        {pages.map((page, i) => (
          <LabelPage key={i} page={page} preset={preset} pageName={pageName} />
        ))}
      </div>
    </div>,
    document.body,
  );
}

function LabelPage({ page, preset, pageName }: { page: readonly LabelItem[]; preset: LabelPreset; pageName: string }) {
  const w = preset.sheet?.widthMm ?? preset.widthMm;
  const h = preset.sheet?.heightMm ?? preset.heightMm;
  const Each = preset.shape === 'wrap' ? WrapLabel : preset.shape === 'flag' ? FlagLabel : Label;
  return (
    <div className={`labels-page labels-page--${pageName.replace(/^label-/, '')}`} style={{ width: `${w}mm`, height: `${h}mm` }}>
      {page.map((item) => (
        <Each key={item.key} item={item} preset={preset} />
      ))}
    </div>
  );
}

const PAD_MM = 2;

function Label({ item, preset }: { item: LabelItem; preset: LabelPreset }) {
  return (
    <div className={preset.sheet ? 'label label--cut' : 'label'} style={{ width: `${preset.widthMm}mm`, height: `${preset.heightMm}mm`, padding: `${PAD_MM}mm`, gap: `${PAD_MM}mm` }}>
      <Face item={item} heightMm={preset.heightMm} />
    </div>
  );
}

/** The name across the tape, once per column, each reading along the cable. */
function WrapLabel({ item, preset }: { item: LabelItem; preset: LabelPreset }) {
  const cols = wrapColumns(preset);
  const colMm = preset.widthMm / cols;
  const withDetail = item.detail !== '' && colMm >= 8;
  const title = Math.min(3.6, colMm * (withDetail ? 0.42 : 0.6));
  return (
    <div className="label label--wrap" style={{ width: `${preset.widthMm}mm`, height: `${preset.heightMm}mm`, padding: `${PAD_MM / 2}mm 0` }} role="img" aria-label={`Wrap label for ${item.title}`}>
      {Array.from({ length: cols }, (_, i) => (
        <span key={i} className="label__wrap-col" style={{ width: `${colMm}mm` }} aria-hidden="true">
          <b style={{ fontSize: `${title}mm` }}>{item.title}</b>
          {withDetail && <span style={{ fontSize: `${Math.min(2.4, colMm * 0.28)}mm` }}>{item.detail}</span>}
        </span>
      ))}
    </div>
  );
}

/** A face either end, with the plain stretch that goes round the cable between them. */
function FlagLabel({ item, preset }: { item: LabelItem; preset: LabelPreset }) {
  const around = preset.widthMm - FLAG_FACE_MM * 2;
  const faceStyle = { width: `${FLAG_FACE_MM}mm`, padding: `${PAD_MM}mm`, gap: `${PAD_MM}mm` };
  return (
    <div className="label label--flag" style={{ width: `${preset.widthMm}mm`, height: `${preset.heightMm}mm` }}>
      <span className="label__face" style={faceStyle}>
        <Face item={item} heightMm={preset.heightMm} titleMaxMm={4} />
      </span>
      <span className="label__around" style={{ width: `${around}mm` }} />
      <span className="label__face" style={faceStyle}>
        <Face item={item} heightMm={preset.heightMm} titleMaxMm={4} />
      </span>
    </div>
  );
}

/** The code and the words beside it. */
function Face({ item, heightMm, titleMaxMm = 6 }: { item: LabelItem; heightMm: number; titleMaxMm?: number }) {
  const drawn = useMemo(() => {
    const symbol = encodeQr(item.link);
    return { side: qrSide(symbol.size), path: qrPath(symbol.modules, QR_QUIET_ZONE) };
  }, [item.link]);
  const qr = heightMm - PAD_MM * 2;
  return (
    <>
      <svg className="label__qr" viewBox={`0 0 ${drawn.side} ${drawn.side}`} shapeRendering="crispEdges" style={{ width: `${qr}mm`, height: `${qr}mm` }} role="img" aria-label={`Code for ${item.title}`}>
        <rect x="0" y="0" width={drawn.side} height={drawn.side} fill="#FFFFFF" />
        <path d={drawn.path} fill="#000000" />
      </svg>
      <span className="label__text">
        <b style={{ fontSize: `${Math.min(titleMaxMm, heightMm * 0.26)}mm` }}>{item.title}</b>
        {item.detail && <span style={{ fontSize: `${Math.min(3.2, heightMm * 0.15)}mm` }}>{item.detail}</span>}
      </span>
    </>
  );
}
