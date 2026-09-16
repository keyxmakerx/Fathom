/**
 * The closet stop's own layout unit — `docs/decisions/adr-0050-the-rear-elevation.md`
 * §2: "the closet stop arranges racks by row, bays left to right as seen
 * from the front... the row's rear elevation reverses the bay order,
 * because you have walked round." Pure: a `RowView` (`document/view.ts`'s
 * own contract — "by bay ascending as seen from the front") and the
 * elevation the row is currently flipped to, in; the bay order to actually
 * render, left to right, and the elevation every rack in the row draws in,
 * out. No DOM, no React Flow.
 */

import type { Facing } from './elevation';
import type { RowView } from './contract';

export interface RowLayout {
  label: string | null;
  /** The row's own flip — ADR-0050 §2: "per row at the closet stop." Every
   * rack in the row draws in this elevation; there is no per-rack override
   * at the closet stop (that is the rack stop's own control). */
  elevation: Facing;
  /** `row.racks` in the order to actually draw left to right: unchanged
   * (bay ascending) for the front elevation, reversed for the rear —
   * "because you have walked round." */
  racks: RowView['racks'];
}

export function layoutRow(row: RowView, elevation: Facing): RowLayout {
  const racks = elevation === 'rear' ? [...row.racks].reverse() : row.racks;
  return { label: row.label, elevation, racks };
}

/** A stable key for a row's own flip state, session-only like `Drawing.tsx`'s
 * other camera state — `label` when the catalogue gives the row one; the
 * index otherwise, since ADR-0050 §2 reads "a rack with no row" as its own
 * (single-rack, unlabelled) row, and two such racks must not collide on a
 * shared `null` key. */
export function rowKey(row: Pick<RowView, 'label'>, index: number): string {
  return row.label ?? `__row-${index}__`;
}
