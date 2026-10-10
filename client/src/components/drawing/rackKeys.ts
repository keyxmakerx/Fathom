// Keys for a device that sits in a rack: Up and Down move it a unit, Ctrl+D duplicates it, Ctrl+C
// and Ctrl+V copy and paste it. (Delete and Ctrl+Z are handled where they always were.) Boxes on the
// free layer have their own keys in `useFreeLayer.tsx`; this stays out of their way.

import { isTypingTarget, matches } from '../shell/shortcuts';
import type { RackView, Selection } from './contract';
import { overlapsRack } from './geometry';

type RackWithDevices = Pick<RackView, 'id' | 'heightU'> & { chassis: ReadonlyArray<{ id: string; positionU: number; heightU: number }> };

/** The rack and device a selection names, when it names a device in a rack. */
export function rackedDevice<R extends RackWithDevices>(racks: readonly R[], selected: Selection | null): { rack: R; device: R['chassis'][number] } | null {
  if (selected?.kind !== 'chassis') return null;
  for (const rack of racks) {
    const device = rack.chassis.find((c) => c.id === selected.id);
    if (device) return { rack, device };
  }
  return null;
}

/** The rack a selection stands in or names: a selected rack, or the rack holding the selected device. */
export function selectedRackId(racks: readonly RackWithDevices[], selected: Selection | null): string | null {
  if (selected?.kind === 'rack') return racks.some((r) => r.id === selected.id) ? selected.id : null;
  return rackedDevice(racks, selected)?.rack.id ?? null;
}

export type NudgePlan = { kind: 'move'; rackId: string; positionU: number } | { kind: 'blocked'; rackId: string };

/** One unit up (`+1`) or down (`-1`): where the device goes, or that it would overlap or leave the rack. */
export function nudgePlan(racks: readonly RackWithDevices[], chassisId: string, direction: 1 | -1): NudgePlan | null {
  const found = rackedDevice(racks, { kind: 'chassis', id: chassisId });
  if (found === null) return null;
  const positionU = found.device.positionU + direction;
  if (overlapsRack(found.rack, { id: chassisId, positionU, heightU: found.device.heightU })) return { kind: 'blocked', rackId: found.rack.id };
  return { kind: 'move', rackId: found.rack.id, positionU };
}

export interface RackKeyContext {
  racks: readonly RackWithDevices[];
  selected: Selection | null;
  canDraw: boolean;
  /** The device last copied, held by the caller between key presses. */
  clipboard: { current: string | null };
  onMove?: (chassisId: string, rackId: string, positionU: number) => void;
  onDuplicate?: (chassisId: string) => void;
  onPaste?: (chassisId: string, rackId: string) => void;
  /** The existing refusal shake, on the rack. */
  shake: (rackId: string) => void;
}

/** Handles the key if it is one of these and applies; true means it was used. */
export function rackDeviceKey(event: KeyboardEvent, ctx: RackKeyContext): boolean {
  if (!ctx.canDraw || isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return false;
  const found = rackedDevice(ctx.racks, ctx.selected);

  if (matches(event, 'copy')) {
    // A copy of anything else clears this clipboard, so a paste follows the last thing copied.
    ctx.clipboard.current = found?.device.id ?? null;
    return false;
  }
  if (matches(event, 'paste')) {
    const target = selectedRackId(ctx.racks, ctx.selected);
    const source = ctx.clipboard.current;
    if (source === null || target === null || !ctx.onPaste) return false;
    if (rackedDevice(ctx.racks, { kind: 'chassis', id: source }) === null) return false;
    event.preventDefault();
    ctx.onPaste(source, target);
    return true;
  }
  if (found === null) return false;
  if (matches(event, 'duplicate')) {
    if (!ctx.onDuplicate) return false;
    event.preventDefault();
    ctx.onDuplicate(found.device.id);
    return true;
  }
  const up = matches(event, 'nudge-up');
  if (up || matches(event, 'nudge-down')) {
    if (!ctx.onMove) return false;
    event.preventDefault();
    const plan = nudgePlan(ctx.racks, found.device.id, up ? 1 : -1);
    if (plan === null) return false;
    if (plan.kind === 'blocked') ctx.shake(plan.rackId);
    else ctx.onMove(found.device.id, plan.rackId, plan.positionU);
    return true;
  }
  return false;
}
