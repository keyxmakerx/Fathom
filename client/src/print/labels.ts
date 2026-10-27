// Labels with a QR code, drawn by Fathom and printed by the browser (ADR-0068 point 8, ADR-0075).
// Pure: which labels, what they say, and the sizes. No label software: the browser prints through the
// printer's own driver, which is how a Brother tape or roll printer is reached on Linux too (Brother
// lists an LPR driver and a CUPS wrapper for its QL printers: support.brother.com, QL-820NWB FAQs,
// read 2026-10-26). Each label is one page of its own size (`@page` named pages, `labels.css`).

import type { InvRow } from '../components/inventory/kinds';
import { scanLink } from '../components/phone/scan';
import type { StoreView } from '../document/stock';

export type LabelPresetId = 'tze-12' | 'tze-18' | 'tze-24' | 'tze-36' | 'wrap-24' | 'flag-24' | 'ql-62' | 'ql-29' | 'a4';

/**
 * How a label goes on. `flat` sticks flat on a face. `wrap` goes round a cable: the tape's width runs
 * along the cable and its length round it, so the name is printed across the tape again and again and
 * reads from any side; a code would curve too tightly round a cable to scan, so a wrap has none.
 * `flag` goes once round the cable and its two ends stick back to back, a flat face either side with
 * the code on each.
 */
export type LabelShape = 'flat' | 'wrap' | 'flag';

export interface LabelPreset {
  id: LabelPresetId;
  name: string;
  shape: LabelShape;
  /** One label, as it comes off the printer. For a wrap or flag the width is for the cable picked. */
  widthMm: number;
  heightMm: number;
  /** Several labels on one sheet, with cut lines; absent for a printer that feeds one at a time. */
  sheet?: { cols: number; rows: number; widthMm: number; heightMm: number };
  note?: string;
}

export type CableThicknessId = 'slim' | 'cat6' | 'cat6a';

/** How thick a cable is, for the length of tape that goes round it. Typical outer sizes, not a spec. */
export const CABLE_THICKNESS: readonly { id: CableThicknessId; name: string; mm: number }[] = [
  { id: 'slim', name: 'Slim patch cable, about 4 mm', mm: 4 },
  { id: 'cat6', name: 'Cat5e or Cat6, about 6 mm', mm: 6 },
  { id: 'cat6a', name: 'Cat6A, about 8 mm', mm: 8 },
];

export const DEFAULT_THICKNESS: CableThicknessId = 'cat6';

export function thicknessOf(id: CableThicknessId) {
  return CABLE_THICKNESS.find((t) => t.id === id) ?? CABLE_THICKNESS[1]!;
}

/** Tape that goes round the cable: its circumference rounded up. */
export function aroundMm(thickness: CableThicknessId): number {
  return Math.ceil(Math.PI * thicknessOf(thickness).mm);
}

/** A wrap goes a little past once round so it sticks to itself. */
const WRAP_OVERLAP_MM = 8;
/** One face of a flag: a 20 mm code and about 24 mm of name beside it on 24 mm tape. */
export const FLAG_FACE_MM = 50;
/** The narrowest column of a wrap's repeated name. */
const WRAP_COLUMN_MIN_MM = 7;

/** The page sizes match `labels.css`'s named pages, which a stylesheet must state ahead of time. */
export const LABEL_PRESETS: readonly LabelPreset[] = [
  { id: 'tze-36', name: 'Brother P-touch tape, 36 mm (TZe)', shape: 'flat', widthMm: 80, heightMm: 36, note: '36 mm tape fits the wider P-touch printers, such as the PT-P910BT.' },
  { id: 'tze-24', name: 'Brother P-touch tape, 24 mm (TZe)', shape: 'flat', widthMm: 64, heightMm: 24 },
  { id: 'tze-18', name: 'Brother P-touch tape, 18 mm (TZe)', shape: 'flat', widthMm: 56, heightMm: 18 },
  {
    id: 'tze-12',
    name: 'Brother P-touch tape, 12 mm (TZe)',
    shape: 'flat',
    widthMm: 48,
    heightMm: 12,
    note: 'The code comes out small on 12 mm tape. Scan a test label before printing many; 18 or 24 mm reads more easily.',
  },
  {
    id: 'wrap-24',
    name: 'Cable wrap, 24 mm tape',
    shape: 'wrap',
    widthMm: 0,
    heightMm: 24,
    note: 'A wrap carries the name all the way round, with no code: a code curves too tightly round a cable to scan. Flexible ID tape (TZe-FX) holds best round a cable. For a code, pick Cable flag.',
  },
  {
    id: 'flag-24',
    name: 'Cable flag, 24 mm tape, with code',
    shape: 'flag',
    widthMm: 0,
    heightMm: 24,
    note: 'Wrap the plain middle once round the cable, then press the two printed ends together back to back.',
  },
  { id: 'ql-62', name: 'Brother QL roll, 62 mm continuous', shape: 'flat', widthMm: 62, heightMm: 29 },
  { id: 'ql-29', name: 'Brother QL labels, 29 × 90 mm', shape: 'flat', widthMm: 90, heightMm: 29 },
  { id: 'a4', name: 'A4 paper, 30 to a sheet with cut lines', shape: 'flat', widthMm: 70, heightMm: 29.7, sheet: { cols: 3, rows: 10, widthMm: 210, heightMm: 297 } },
];

export const DEFAULT_PRESET: LabelPresetId = 'tze-24';
/** Cables default to a wrap, the label that goes round an Ethernet cable. */
export const DEFAULT_CABLE_PRESET: LabelPresetId = 'wrap-24';

/** A wrap or flag goes round a cable, so it is offered only for cables. */
export const isCableOnly = (p: LabelPreset) => p.shape !== 'flat';

/** The labels offered for a print: wraps and flags only when printing cables. */
export function presetsFor(cables: boolean): readonly LabelPreset[] {
  return cables ? LABEL_PRESETS : LABEL_PRESETS.filter((p) => !isCableOnly(p));
}

/** A preset, sized for the cable when it goes round one. */
export function presetOf(id: LabelPresetId, thickness: CableThicknessId = DEFAULT_THICKNESS): LabelPreset {
  const p = LABEL_PRESETS.find((x) => x.id === id) ?? LABEL_PRESETS.find((x) => x.id === DEFAULT_PRESET)!;
  if (p.shape === 'wrap') return { ...p, widthMm: aroundMm(thickness) + WRAP_OVERLAP_MM };
  if (p.shape === 'flag') return { ...p, widthMm: FLAG_FACE_MM * 2 + aroundMm(thickness) };
  return p;
}

/** The named page in `labels.css` a preset prints on; a wrap or flag has one per cable thickness. */
export function pageNameOf(id: LabelPresetId, thickness: CableThicknessId = DEFAULT_THICKNESS): string {
  const p = presetOf(id, thickness);
  return p.shape === 'flat' ? `label-${p.id}` : `label-${p.id}-${thickness}`;
}

/** How many times a wrap repeats the name along its length: a column at least 7 mm wide each. */
export function wrapColumns(preset: LabelPreset): number {
  return Math.max(2, Math.floor(preset.widthMm / WRAP_COLUMN_MIN_MM));
}

export interface LabelItem {
  /** Unique within one print, copies included. */
  key: string;
  title: string;
  detail: string;
  /** What the QR code says: this server's scan link for the item. */
  link: string;
}

/** The Inventory kinds a label is printed for. */
export const LABEL_KINDS = ['devices', 'racks', 'cables', 'ports'] as const;
export type LabelListKind = (typeof LABEL_KINDS)[number];
export const isLabelListKind = (k: string): k is LabelListKind => (LABEL_KINDS as readonly string[]).includes(k);

/** The node a row's label points at, or null for a row with none. */
function nodeOf(kind: LabelListKind, row: InvRow): string | null {
  if (kind === 'devices') return row.ids.chassisId ?? null;
  if (kind === 'racks') return row.ids.rackId ?? null;
  if (kind === 'cables') return row.ids.cableId ?? null;
  return row.selection?.kind === 'port' ? row.selection.id : null;
}

function titleOf(kind: LabelListKind, row: InvRow): string {
  const c = row.cells;
  if (kind === 'ports') return [c.device, c.name].filter(Boolean).join(' ');
  return c.name || row.title;
}

function detailOf(kind: LabelListKind, row: InvRow): string {
  const c = row.cells;
  if (kind === 'devices') return c.where ?? '';
  if (kind === 'racks') return [c.row, `${c.height}U`].filter(Boolean).join(' · ');
  if (kind === 'cables') return [c.endA, c.endB].filter(Boolean).join(' ⇄ ');
  return c.cable ? `→ ${c.cable}` : '';
}

/**
 * One label per row, two per cable (one for each end, the same label: either end opens the same
 * page). Rows with nothing to point at are left out.
 */
export function labelItems(kind: LabelListKind, rows: readonly InvRow[], origin: string, designId: string): LabelItem[] {
  const out: LabelItem[] = [];
  for (const row of rows) {
    const nodeId = nodeOf(kind, row);
    if (nodeId == null) continue;
    const item = { title: titleOf(kind, row) || '(no name)', detail: detailOf(kind, row), link: scanLink(origin, { designId, nodeId }) };
    const copies = kind === 'cables' ? 2 : 1;
    for (let i = 0; i < copies; i += 1) out.push({ ...item, key: `${row.key}#${i}` });
  }
  return out;
}

/** The label for a store's bin: scanning it opens the store's page (ADR-0075). */
export function storeLabel(store: StoreView, origin: string, designId: string): LabelItem {
  return { key: store.id, title: store.name || '(no name)', detail: store.place ?? '', link: scanLink(origin, { designId, nodeId: store.id }) };
}

/** Labels laid out on sheets: one per page for a tape or roll, `cols × rows` per page on paper. */
export function pagesOf(items: readonly LabelItem[], preset: LabelPreset): LabelItem[][] {
  const per = preset.sheet ? preset.sheet.cols * preset.sheet.rows : 1;
  const pages: LabelItem[][] = [];
  for (let i = 0; i < items.length; i += per) pages.push(items.slice(i, i + per));
  return pages;
}
