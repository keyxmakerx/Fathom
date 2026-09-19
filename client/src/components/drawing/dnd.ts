import type { PaletteItem } from './contract';

/** The one payload the palette's native HTML5 drag carries, read back by
 * `Drawing.tsx`'s drop handler on the canvas. */
export const PALETTE_DRAG_MIME = 'application/x-fathom-palette-item';

export interface PaletteDragPayload {
  vendor: string;
  model: string;
  rackUnits: number;
}

export function encodePaletteDrag(item: PaletteItem): string {
  const payload: PaletteDragPayload = { vendor: item.vendor, model: item.model, rackUnits: item.rackUnits };
  return JSON.stringify(payload);
}

/** Never throws on a foreign or malformed drag payload — a drop from
 * outside this drawing (or a corrupted transfer) is simply not a valid
 * placement, not a crash. */
export function decodePaletteDrag(raw: string): PaletteDragPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed != null &&
      typeof (parsed as PaletteDragPayload).vendor === 'string' &&
      typeof (parsed as PaletteDragPayload).model === 'string' &&
      typeof (parsed as PaletteDragPayload).rackUnits === 'number'
    ) {
      return parsed as PaletteDragPayload;
    }
    return null;
  } catch {
    return null;
  }
}
