import { loadJsonPref, saveJsonPref } from '../../prefs';
/** The Show menu's layers (ADR-0061 round 10): words added to the canvas, per
 * person, per design, kept in this browser — never a document field. A layer
 * with `available: false` has no data on main yet; flip it when its PR lands
 * and the menu lists it. */

export const LAYER_IDS = ['checks', 'addresses', 'vlans', 'docs', 'maintenance', 'tags', 'learn', 'vpns'] as const;

export type LayerId = (typeof LAYER_IDS)[number];

export interface LayerSpec {
  id: LayerId;
  label: string;
  onByDefault: boolean;
  available: boolean;
}

export const LAYERS: readonly LayerSpec[] = [
  { id: 'checks', label: 'Checks', onByDefault: true, available: true },
  { id: 'addresses', label: 'Addresses', onByDefault: false, available: true },
  { id: 'vlans', label: 'VLANs', onByDefault: false, available: true },
  { id: 'docs', label: 'Docs', onByDefault: false, available: true },
  { id: 'maintenance', label: 'Maintenance', onByDefault: false, available: true },
  { id: 'tags', label: 'Tags', onByDefault: false, available: true },
  // ADR-0066 item 1.2: plain notes that teach what is on the drawing (the r4-teach Learn switch).
  { id: 'learn', label: 'Learn notes', onByDefault: false, available: true },
  // Mesh VPNs (schema 0.26): each VPN a badge with dashed spokes to its members.
  { id: 'vpns', label: 'VPNs', onByDefault: false, available: true },
];

export type LayerSet = Readonly<Record<LayerId, boolean>>;

export function defaultLayers(): LayerSet {
  return Object.fromEntries(LAYERS.map((l) => [l.id, l.onByDefault])) as Record<LayerId, boolean>;
}

/** Drops anything stored that is not a known layer; a missing one takes its default. */
export function parseLayers(raw: unknown): LayerSet {
  const out = { ...defaultLayers() };
  if (typeof raw !== 'object' || raw === null) return out;
  for (const id of LAYER_IDS) {
    const v = (raw as Record<string, unknown>)[id];
    if (typeof v === 'boolean') out[id] = v;
  }
  return out;
}

function keyFor(accountId: string | null, designId: string | undefined): string {
  return `fathom.layers.${accountId ?? 'anon'}.${designId ?? 'unsaved'}`;
}

/** Best effort: private mode or a blocked store gives the defaults. */
export function loadLayers(accountId: string | null, designId: string | undefined): LayerSet {
  return loadJsonPref(keyFor(accountId, designId), parseLayers, defaultLayers());
}

export function saveLayers(accountId: string | null, designId: string | undefined, layers: LayerSet): void {
  saveJsonPref(keyFor(accountId, designId), layers);
}

/** Whether a layer is both ticked and has data to draw. */
export function layerOn(layers: LayerSet, id: LayerId): boolean {
  return layers[id] && (LAYERS.find((l) => l.id === id)?.available ?? false);
}
