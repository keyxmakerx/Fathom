/** Side-panel widths: the drag limits, the "canvas never gets squeezed" rule, and the
 * per-panel width this browser remembers. Pure apart from the two storage functions. */

export type PanelId = 'rail' | 'details' | 'history' | 'trail';

/** The narrowest a panel can be dragged to. */
export const PANEL_MIN = 240;
/** The canvas always keeps at least this much width; a panel is clamped before the canvas is. */
export const CANVAS_MIN = 360;
/** In a window too narrow for both, a panel may go below `PANEL_MIN`, but never below this. */
export const PANEL_FLOOR = 160;
/** One arrow-key press, and one with Shift held. */
export const KEY_STEP = 16;
export const KEY_STEP_BIG = 64;

export const PANEL_DEFAULT: Readonly<Record<PanelId, number>> = {
  rail: 240,
  details: 316,
  history: 316,
  trail: 420,
};

/** No panel is wider than half the window. */
export function panelCap(windowWidth: number): number {
  return Math.max(PANEL_MIN, Math.floor(windowWidth / 2));
}

export interface FitInput {
  /** The width of the row that holds the strips, the panels and the canvas. */
  bodyWidth: number;
  windowWidth: number;
  /** Total width of the strips that are drawn (the folded edges). */
  stripsWidth: number;
  /** The wanted width of each panel, or `null` when that side is folded. */
  left: number | null;
  right: number | null;
}

export interface Fit {
  left: number;
  right: number;
}

/** The widths to draw: each wanted width limited to the drag range, then both shrunk together
 * until the canvas keeps `CANVAS_MIN`. A folded side is 0. */
export function fitPanels({ bodyWidth, windowWidth, stripsWidth, left, right }: FitInput): Fit {
  const cap = panelCap(windowWidth);
  const clamp = (w: number) => Math.min(cap, Math.max(PANEL_MIN, Math.round(w)));
  let l = left == null ? 0 : clamp(left);
  let r = right == null ? 0 : clamp(right);
  const room = Math.max(0, bodyWidth - stripsWidth - CANVAS_MIN);
  let excess = l + r - room;
  if (excess <= 0) return { left: l, right: r };

  // First take from what is above the minimum, in proportion.
  const lSpare = l > 0 ? l - PANEL_MIN : 0;
  const rSpare = r > 0 ? r - PANEL_MIN : 0;
  const spare = lSpare + rSpare;
  if (spare > 0) {
    const cut = Math.min(excess, spare);
    const cutL = Math.min(lSpare, Math.round((cut * lSpare) / spare));
    const cutR = Math.min(rSpare, cut - cutL);
    l -= cutL;
    r -= cutR;
    excess = l + r - room;
  }
  // Then, in a window too narrow for the minimums, go below them but never past the floor.
  if (excess > 0) {
    const open = (l > 0 ? 1 : 0) + (r > 0 ? 1 : 0);
    const each = Math.ceil(excess / Math.max(1, open));
    if (l > 0) l = Math.max(PANEL_FLOOR, l - each);
    if (r > 0) r = Math.max(PANEL_FLOOR, r - each);
  }
  return { left: l, right: r };
}

/** The most one panel can be dragged to right now: half the window, and what the canvas leaves
 * once the other open panel and the strips are counted. Never below the minimum. */
export function panelMax(windowWidth: number, bodyWidth: number, stripsWidth: number, otherOpenWidth: number): number {
  const room = bodyWidth - stripsWidth - CANVAS_MIN - otherOpenWidth;
  return Math.max(PANEL_MIN, Math.min(panelCap(windowWidth), Math.floor(room)));
}

/** A dragged or typed width, held to the range. */
export function clampWidth(width: number, max: number): number {
  return Math.min(max, Math.max(PANEL_MIN, Math.round(width)));
}

/** The width after an arrow key on the handle's edge. `grows` says whether this key moves the
 * handle the way that widens the panel. Null for a key that does nothing here. */
export function keyedWidth(current: number, key: string, shift: boolean, growKey: 'ArrowLeft' | 'ArrowRight', max: number): number | null {
  const step = shift ? KEY_STEP_BIG : KEY_STEP;
  if (key === 'Home') return PANEL_MIN;
  if (key === 'End') return max;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  const next = key === growKey ? current + step : current - step;
  return clampWidth(next, max);
}

// ---- remembered widths (this browser, per panel) --------------------------

const storageKey = (id: PanelId) => `fathom.panel-width.${id}`;

/** Best effort: private mode or a blocked store gives the default. */
export function loadPanelWidth(id: PanelId): number {
  try {
    const raw = localStorage.getItem(storageKey(id));
    if (raw != null) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= PANEL_MIN && n <= 4000) return Math.round(n);
    }
  } catch {
    // storage unavailable: default
  }
  return PANEL_DEFAULT[id];
}

export function savePanelWidth(id: PanelId, width: number): void {
  try {
    if (width === PANEL_DEFAULT[id]) localStorage.removeItem(storageKey(id));
    else localStorage.setItem(storageKey(id), String(Math.round(width)));
  } catch {
    // not remembered
  }
}
