// Edit many at once: the pure parts. Which devices are selected and what they share, and where a set of
// devices would land in a chosen rack. The writes themselves are `document/bulk.ts`.

import type { ChassisView, ClosetView, RackView } from '../../document/view';

export interface DeviceRow {
  /** The chassis id, which is also its selection id. */
  chassisId: string;
  deviceId: string;
  hostname: string;
  role: string | null;
  /** The rack units it takes. A box not in a rack moves as 1U, as the move command reads it. */
  heightU: number;
  rackId: string | null;
  rackLabel: string | null;
}

/** The rows for the chosen chassis ids, in the order given; an id that is no longer in the design is skipped. */
export function deviceRows(view: Pick<ClosetView, 'racks' | 'unplaced'>, chassisIds: readonly string[]): DeviceRow[] {
  const byId = new Map<string, DeviceRow>();
  const add = (c: ChassisView, rack: RackView | null) =>
    byId.set(c.id, {
      chassisId: c.id,
      deviceId: c.deviceId,
      hostname: c.hostname,
      role: c.role,
      heightU: rack ? c.heightU : 1,
      rackId: rack?.id ?? null,
      rackLabel: rack?.label ?? null,
    });
  for (const rack of view.racks) for (const c of rack.chassis) add(c, rack);
  for (const c of view.unplaced) add(c, null);
  return chassisIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/** `shared` when every value is the same, `mixed` when they differ. */
export function sharedValue<T>(values: readonly T[]): { kind: 'shared'; value: T } | { kind: 'mixed' } | { kind: 'none' } {
  if (values.length === 0) return { kind: 'none' };
  const first = values[0]!;
  return values.every((v) => v === first) ? { kind: 'shared', value: first } : { kind: 'mixed' };
}

export type RackMovePlan =
  | { ok: true; moves: { itemId: string; rackId: string; positionU: number }[]; alreadyThere: number }
  | { ok: false; reason: string };

const units = (n: number): string => `${n}U`;

/**
 * Where `rows` land in `rack`: each in the lowest free run it fits, one after another, in the order given.
 * A device already in this rack stays where it is. Refuses, in words, when they do not all fit.
 */
export function planRackMove(rack: Pick<RackView, 'id' | 'label' | 'heightU' | 'chassis' | 'shelves'>, rows: readonly DeviceRow[]): RackMovePlan {
  const moving = rows.filter((r) => r.rackId !== rack.id);
  const alreadyThere = rows.length - moving.length;
  if (moving.length === 0) return { ok: true, moves: [], alreadyThere };

  const taken = new Array<boolean>(rack.heightU + 2).fill(false);
  const take = (from: number, h: number) => {
    for (let u = from; u < from + h; u += 1) if (u >= 1 && u <= rack.heightU) taken[u] = true;
  };
  for (const c of rack.chassis) take(c.positionU, c.heightU);
  for (const s of rack.shelves) take(s.positionU, s.heightU);

  const free = (): number => taken.slice(1, rack.heightU + 1).filter((t) => !t).length;
  const need = moving.reduce((sum, r) => sum + r.heightU, 0);
  if (need > free()) {
    return { ok: false, reason: `${rack.label || 'That rack'} has ${units(free())} free and these devices need ${units(need)}. Nothing was moved.` };
  }

  const moves: { itemId: string; rackId: string; positionU: number }[] = [];
  for (const row of moving) {
    let at = -1;
    for (let u = 1; u + row.heightU - 1 <= rack.heightU && at < 0; u += 1) {
      let fits = true;
      for (let k = u; k < u + row.heightU; k += 1) if (taken[k]) fits = false;
      if (fits) at = u;
    }
    if (at < 0) {
      return {
        ok: false,
        reason: `The free space in ${rack.label || 'that rack'} is split up, and ${row.hostname || 'a device'} (${units(row.heightU)}) does not fit in any gap. Nothing was moved.`,
      };
    }
    take(at, row.heightU);
    moves.push({ itemId: row.chassisId, rackId: rack.id, positionU: at });
  }
  return { ok: true, moves, alreadyThere };
}

/** The title over the panel. */
export function selectionTitle(count: number): string {
  return `${count} devices selected`;
}
