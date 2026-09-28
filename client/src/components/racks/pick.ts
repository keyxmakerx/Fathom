import type { Document } from '../../document/model';
import type { RackView } from '../../document/view';

/** Pure: the highest unit where `units` free units start in `rack`, filling
 * from the top down, or null when nothing that tall fits. */
export function highestFreeU(rack: Pick<RackView, 'heightU' | 'chassis' | 'shelves'>, units: number): number | null {
  const taken = new Set<number>();
  for (const item of [...rack.chassis, ...rack.shelves]) {
    for (let u = item.positionU; u < item.positionU + item.heightU; u += 1) taken.add(u);
  }
  for (let start = rack.heightU - units + 1; start >= 1; start -= 1) {
    let free = true;
    for (let u = start; u < start + units && free; u += 1) free = !taken.has(u);
    if (free) return start;
  }
  return null;
}

/** Pure: the racks to try for a clicked item, the one in use first — the
 * selected rack, or the rack holding the selected device. */
export function racksInPickOrder<R extends Pick<RackView, 'id' | 'chassis'>>(
  racks: readonly R[],
  selection: { kind: string; id: string } | null,
): R[] {
  const inUse =
    selection === null
      ? undefined
      : racks.find((r) => (selection.kind === 'rack' && r.id === selection.id) || (selection.kind === 'chassis' && r.chassis.some((c) => c.id === selection.id)));
  return inUse ? [inUse, ...racks.filter((r) => r !== inUse)] : [...racks];
}

/** Pure: the first free name like router-1 for a common device of `role`. */
export function nextHostname(taken: ReadonlySet<string>, role: string): string {
  const prefix = role.replace(/_/g, '-');
  let n = 1;
  while (taken.has(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

/** Every device name already in `doc`, so a new common device gets a fresh one. */
export function hostnamesOf(doc: Document): Set<string> {
  const names = new Set<string>();
  for (const node of doc.nodes) {
    const value = node.fields['Device.hostname']?.value;
    if (typeof value === 'string') names.add(value);
  }
  return names;
}
