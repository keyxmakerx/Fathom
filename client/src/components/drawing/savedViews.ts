/** Saved views: a camera position together with its Show layers, named ("Core rack, VLANs on") and
 * come back to in one click. Per person and design, kept in this browser (like `layers.ts`, and
 * Inventory's "Mine" views) — never a document field. */
import { LAYER_IDS, parseLayers, type LayerSet } from './layers';
import type { Look } from './look';

export interface ViewCamera {
  x: number;
  y: number;
  zoom: number;
}

export interface SavedView {
  id: string;
  name: string;
  look: Look;
  camera: ViewCamera;
  layers: LayerSet;
}

export const MAX_VIEWS = 20;
export const MAX_NAME = 40;

export function viewsKey(accountId: string | null, designId: string | undefined): string {
  return `fathom.views.${accountId ?? 'anon'}.${designId ?? 'unsaved'}`;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A name as it will be kept: trimmed, one line, not too long. Empty means not a name. */
export function tidyName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

/** Keeps the views that are whole and drops the rest. */
export function parseViews(raw: unknown): SavedView[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedView[] = [];
  const seen = new Set<string>();
  for (const e of raw) {
    const v = e as Record<string, unknown> | null;
    if (v == null || typeof v !== 'object') continue;
    const cam = v.camera as Record<string, unknown> | null | undefined;
    if (typeof v.id !== 'string' || v.id === '' || seen.has(v.id)) continue;
    if (typeof v.name !== 'string' || tidyName(v.name) === '') continue;
    if (v.look !== 'rack' && v.look !== 'diagram') continue;
    if (cam == null || !finite(cam.x) || !finite(cam.y) || !finite(cam.zoom) || cam.zoom <= 0) continue;
    seen.add(v.id);
    out.push({ id: v.id, name: tidyName(v.name), look: v.look, camera: { x: cam.x, y: cam.y, zoom: cam.zoom }, layers: parseLayers(v.layers) });
  }
  return out.slice(0, MAX_VIEWS);
}

export function loadViews(accountId: string | null, designId: string | undefined): SavedView[] {
  try {
    const raw = localStorage.getItem(viewsKey(accountId, designId));
    if (raw != null) return parseViews(JSON.parse(raw));
  } catch {
    // storage unavailable or damaged: none saved
  }
  return [];
}

export function saveViews(accountId: string | null, designId: string | undefined, views: readonly SavedView[]): void {
  try {
    localStorage.setItem(viewsKey(accountId, designId), JSON.stringify(views));
  } catch {
    // not remembered
  }
}

export function newViewId(now: number = Date.now()): string {
  return `v${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Adds a view at the end. A name already in use is refused with a sentence, as is a full list. */
export function addView(views: readonly SavedView[], view: SavedView): { views: SavedView[] } | { refused: string } {
  const name = tidyName(view.name);
  if (name === '') return { refused: 'Give the view a name.' };
  if (views.length >= MAX_VIEWS) return { refused: `You can keep ${MAX_VIEWS} views. Delete one first.` };
  if (views.some((v) => v.name.toLowerCase() === name.toLowerCase())) return { refused: 'A view with that name already exists.' };
  return { views: [...views, { ...view, name }] };
}

export function renameView(views: readonly SavedView[], id: string, rawName: string): { views: SavedView[] } | { refused: string } {
  const name = tidyName(rawName);
  if (name === '') return { refused: 'Give the view a name.' };
  if (views.some((v) => v.id !== id && v.name.toLowerCase() === name.toLowerCase())) return { refused: 'A view with that name already exists.' };
  return { views: views.map((v) => (v.id === id ? { ...v, name } : v)) };
}

export function removeView(views: readonly SavedView[], id: string): SavedView[] {
  return views.filter((v) => v.id !== id);
}

/** The layers a view turns on, as words: "VLANs, Addresses". */
export function layersSummary(layers: LayerSet, labels: Readonly<Record<string, string>>): string {
  const on = LAYER_IDS.filter((id) => layers[id]).map((id) => labels[id] ?? id);
  return on.length === 0 ? 'no layers' : on.join(', ');
}

/** How many saved views get a button in the bar; the rest are in the Views menu. */
export const BAR_VIEWS = 3;

/** Is the drawing showing this view right now: same look, same Show layers, and a camera within a
 * hair of where the view put it. Used to mark the current view in the bar. */
export function viewIsCurrent(view: SavedView, now: { look: Look; layers: LayerSet; camera: ViewCamera | null }): boolean {
  if (now.camera == null || view.look !== now.look) return false;
  if (!LAYER_IDS.every((id) => view.layers[id] === now.layers[id])) return false;
  const near = Math.abs(view.camera.zoom - now.camera.zoom) <= view.camera.zoom * 0.01;
  return near && Math.abs(view.camera.x - now.camera.x) <= 4 && Math.abs(view.camera.y - now.camera.y) <= 4;
}
