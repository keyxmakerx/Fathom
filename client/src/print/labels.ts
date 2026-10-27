// Labels with a QR code, drawn by Fathom and printed by the browser (ADR-0068 point 8, ADR-0075).
// Pure: which labels, what they say, and the sizes. No label software: the browser prints through the
// printer's own driver, which is how a Brother tape or roll printer is reached on Linux too (Brother
// lists an LPR driver and a CUPS wrapper for its QL printers: support.brother.com, QL-820NWB FAQs,
// read 2026-10-26). Each label is one page of its own size (`@page` named pages, `labels.css`).

import type { InvRow } from '../components/inventory/kinds';
import { scanLink } from '../components/phone/scan';

export type LabelPresetId = 'tze-12' | 'tze-18' | 'tze-24' | 'ql-62' | 'ql-29' | 'a4';

export interface LabelPreset {
  id: LabelPresetId;
  name: string;
  /** One label, as it comes off the printer. */
  widthMm: number;
  heightMm: number;
  /** Several labels on one sheet, with cut lines; absent for a printer that feeds one at a time. */
  sheet?: { cols: number; rows: number; widthMm: number; heightMm: number };
  note?: string;
}

/** The page sizes match `labels.css`'s named pages, which a stylesheet must state ahead of time. */
export const LABEL_PRESETS: readonly LabelPreset[] = [
  { id: 'tze-24', name: 'Brother P-touch tape, 24 mm (TZe)', widthMm: 64, heightMm: 24 },
  { id: 'tze-18', name: 'Brother P-touch tape, 18 mm (TZe)', widthMm: 56, heightMm: 18 },
  {
    id: 'tze-12',
    name: 'Brother P-touch tape, 12 mm (TZe)',
    widthMm: 48,
    heightMm: 12,
    note: 'The code comes out small on 12 mm tape. Scan a test label before printing many; 18 or 24 mm reads more easily.',
  },
  { id: 'ql-62', name: 'Brother QL roll, 62 mm continuous', widthMm: 62, heightMm: 29 },
  { id: 'ql-29', name: 'Brother QL labels, 29 × 90 mm', widthMm: 90, heightMm: 29 },
  { id: 'a4', name: 'A4 paper, 30 to a sheet with cut lines', widthMm: 70, heightMm: 29.7, sheet: { cols: 3, rows: 10, widthMm: 210, heightMm: 297 } },
];

export const DEFAULT_PRESET: LabelPresetId = 'tze-24';

export function presetOf(id: LabelPresetId): LabelPreset {
  return LABEL_PRESETS.find((p) => p.id === id) ?? LABEL_PRESETS[0]!;
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

/** Labels laid out on sheets: one per page for a tape or roll, `cols × rows` per page on paper. */
export function pagesOf(items: readonly LabelItem[], preset: LabelPreset): LabelItem[][] {
  const per = preset.sheet ? preset.sheet.cols * preset.sheet.rows : 1;
  const pages: LabelItem[][] = [];
  for (let i = 0; i < items.length; i += per) pages.push(items.slice(i, i + per));
  return pages;
}
