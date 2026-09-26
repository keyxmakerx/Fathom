// Rack-unit labelling shared by the rack sheet and the cut sheet.
// `positionU` (`document/view.ts`) always counts from the bottom, 1..heightU
// — `RackNode.tsx`'s own reading. `unitNumbering` only flips which label
// text a physical row carries: 'ascending' labels the bottom row "1" and
// counts up (the label equals `positionU` itself); 'descending' labels the
// TOP row "1" and counts down.

export function unitLabel(rackHeightU: number, unitNumbering: string, positionU: number): number {
  return unitNumbering === 'descending' ? rackHeightU - positionU + 1 : positionU;
}

/** A chassis's own occupied units as the printed table shows them, e.g.
 * `"22"` for a 1U device or `"17–18"` for a 2U one — low label first
 * regardless of numbering direction. */
export function unitRangeLabel(rackHeightU: number, unitNumbering: string, positionU: number, heightU: number): string {
  const a = unitLabel(rackHeightU, unitNumbering, positionU);
  const b = unitLabel(rackHeightU, unitNumbering, positionU + heightU - 1);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return lo === hi ? String(lo) : `${lo}–${hi}`;
}

/** A row's physical distance from the top of the rack, 0-based — the
 * drawing order `RackNode.tsx`'s own `rowTop` already uses, restated here
 * pure so the sheet builders never need a DOM measurement to page a rack. */
export function physicalTopRow(rackHeightU: number, item: { positionU: number; heightU: number }): number {
  return rackHeightU - (item.positionU + item.heightU - 1);
}

export function physicalBottomRow(rackHeightU: number, item: { positionU: number; heightU: number }): number {
  return physicalTopRow(rackHeightU, item) + item.heightU - 1;
}
