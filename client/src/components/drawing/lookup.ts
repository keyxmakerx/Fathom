import type { ChassisView, ClosetView, PortView, RackView } from './contract';

/** Pure lookups over the view, shared by the editor and the drawing. Never
 * invents a result: each returns `undefined` when the id names nothing in
 * this view, rather than guessing. */

export function findRack(view: ClosetView, rackId: string): RackView | undefined {
  return view.racks.find((r) => r.id === rackId);
}

export function findChassis(
  view: ClosetView,
  chassisId: string,
): { rack: RackView; chassis: ChassisView } | undefined {
  for (const rack of view.racks) {
    const chassis = rack.chassis.find((c) => c.id === chassisId);
    if (chassis != null) return { rack, chassis };
  }
  return undefined;
}

export function findPort(
  view: ClosetView,
  portId: string,
): { rack: RackView; chassis: ChassisView; port: PortView } | undefined {
  for (const rack of view.racks) {
    for (const chassis of rack.chassis) {
      const port = chassis.ports.find((p) => p.id === portId);
      if (port != null) return { rack, chassis, port };
    }
  }
  return undefined;
}
