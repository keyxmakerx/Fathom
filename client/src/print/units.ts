// Rack-unit labelling shared by the rack sheet and the cut sheet.
// `positionU` counts from the bottom; `unitNumbering` only flips the label.

export function unitLabel(rackHeightU: number, unitNumbering: string, positionU: number): number {
  return unitNumbering === 'descending' ? rackHeightU - positionU + 1 : positionU;
}

/** A chassis's own occupied units, e.g. `"22"` or `"17–18"` — low label first regardless of numbering direction. */
export function unitRangeLabel(rackHeightU: number, unitNumbering: string, positionU: number, heightU: number): string {
  const a = unitLabel(rackHeightU, unitNumbering, positionU);
  const b = unitLabel(rackHeightU, unitNumbering, positionU + heightU - 1);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return lo === hi ? String(lo) : `${lo}–${hi}`;
}

/** A row's physical distance from the top of the rack, 0-based. */
export function physicalTopRow(rackHeightU: number, item: { positionU: number; heightU: number }): number {
  return rackHeightU - (item.positionU + item.heightU - 1);
}

export function physicalBottomRow(rackHeightU: number, item: { positionU: number; heightU: number }): number {
  return physicalTopRow(rackHeightU, item) + item.heightU - 1;
}
