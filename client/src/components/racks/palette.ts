// The palette's rows, built from the catalogue — never typed. Each item's
// summary is counted off that model's own faceplates, so it changes the
// moment the catalogue entry does, rather than a hand-written description
// drifting out of sync with it.

import type { CatalogueModel } from '../../api/catalogue';
import type { PaletteItem } from '../drawing';

/** Every port across every one of a model's faceplates, totalled by the
 * catalogue's own connector token (`"RJ45"`, `"SFP+"`, ...) and joined in
 * the order those tokens were first seen — deterministic, never sorted
 * into an order the catalogue itself does not carry. */
function summarise(model: CatalogueModel): string {
  const counts = new Map<string, number>();
  for (const faceplate of model.faceplates) {
    for (const port of faceplate.ports) {
      counts.set(port.kind, (counts.get(port.kind) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return 'No ports listed';
  return Array.from(counts.entries())
    .map(([kind, count]) => `${count} ${kind}`)
    .join(' · ');
}

export function paletteFromCatalogue(catalogue: readonly CatalogueModel[]): PaletteItem[] {
  return catalogue.map((model) => ({
    vendor: model.vendor,
    model: model.model,
    rackUnits: model.rackUnits,
    summary: summarise(model),
  }));
}

// ADR-0051 §1/§2, this session's brief item 2 — two rows beside the
// catalogue's own models: "a box with no catalogue entry"
// (`document/commands.ts`'s `createSketchDevice`) and "a board"
// (`createBoard`). Both are ordinary `PaletteItem`s — `vendor: ''` never
// matches a real catalogue entry (every one of those names a real vendor,
// `api/catalogue.ts`'s own contract) — so the SAME drag/drop wiring
// (`dnd.ts`'s `encodePaletteDrag`/`decodePaletteDrag`, `Drawing.tsx`'s
// `handleDrop`, both off limits this session) carries them with no changes
// of its own; `racks/RacksPlace.tsx`'s `handlePlace` tells the two apart
// from a real catalogue drop by vendor alone, before it ever looks the drop
// up in `catalogue` (`isSketchDevicePaletteItem`/`isBoardPaletteItem`
// below).
export const SKETCH_DEVICE_MODEL = 'sketch-device';
export const BOARD_MODEL = 'board';

export const SKETCH_DEVICE_PALETTE_ITEM: PaletteItem = {
  vendor: '',
  model: SKETCH_DEVICE_MODEL,
  rackUnits: 1,
  summary: 'No catalogue entry — name it, then type its ports',
};

export const BOARD_PALETTE_ITEM: PaletteItem = {
  vendor: '',
  model: BOARD_MODEL,
  rackUnits: 1,
  summary: 'Plywood fixed to a wall, floor, desk or ceiling — other things fix to it',
};

export function isSketchDevicePaletteItem(item: Pick<PaletteItem, 'vendor' | 'model'>): boolean {
  return item.vendor === SKETCH_DEVICE_PALETTE_ITEM.vendor && item.model === SKETCH_DEVICE_PALETTE_ITEM.model;
}

export function isBoardPaletteItem(item: Pick<PaletteItem, 'vendor' | 'model'>): boolean {
  return item.vendor === BOARD_PALETTE_ITEM.vendor && item.model === BOARD_PALETTE_ITEM.model;
}

/** The palette's full row list, `paletteFromCatalogue`'s own rows followed
 * by the two sketch rows above — used only for the rail's draggable list
 * (`racks/RacksPlace.tsx`'s `<Palette>`), never for a control that means
 * "a real catalogue model" (`Editor.tsx`'s `AddShelfControl` keeps using
 * `paletteFromCatalogue` alone, so a shelf's own optional model never
 * offers "sketch-device" or "board" as if either were one). */
export function paletteRows(catalogue: readonly CatalogueModel[]): PaletteItem[] {
  return [...paletteFromCatalogue(catalogue), SKETCH_DEVICE_PALETTE_ITEM, BOARD_PALETTE_ITEM];
}
