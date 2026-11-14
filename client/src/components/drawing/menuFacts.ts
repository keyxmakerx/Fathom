// r116: what a port's and a cable's menus read off the drawing: where the cable goes, which end is which and
// which device a trace starts from. Pure; the menus themselves are `contextMenuItems.ts`.

import type { CableEndFacts, PortFacts } from './contextMenuItems';
import type { ClosetView } from './contract';
import { locatePort } from './lookup';

/** The port's cable and what is at its far end, wherever the port sits (rack, shelf or wall). */
export function portFactsOf(view: ClosetView, portId: string): PortFacts | null {
  const at = locatePort(view, portId);
  if (at == null) return null;
  const deviceId = at.place === 'chassis' ? at.chassis.id : at.place === 'shelf' ? at.occupant.id : at.fixture.id;
  const cable = at.port.cable;
  const ends = cable != null ? ((view.cables ?? []).find((c) => c.id === cable.cableId)?.ends ?? []) : [];
  const outside = ends.find((e) => 'outside' in e);
  return {
    cableId: cable?.cableId ?? null,
    farPortId: cable?.farPortId ?? null,
    far: outside != null && 'outside' in outside ? (outside.far ?? null) : null,
    deviceId,
  };
}

/** A cable's two ends in the order it holds them, A then B; null where it has no such end yet. */
export function cableEndsOf(view: ClosetView, cableId: string): readonly [CableEndFacts | null, CableEndFacts | null] {
  const cable = (view.cables ?? []).find((c) => c.id === cableId);
  const one = (i: number): CableEndFacts | null => {
    const end = cable?.ends[i];
    if (end == null) return null;
    return 'portId' in end ? { portId: end.portId, chassisId: end.chassisId, far: null } : { portId: null, chassisId: null, far: end.far ?? null };
  };
  return [one(0), one(1)];
}
