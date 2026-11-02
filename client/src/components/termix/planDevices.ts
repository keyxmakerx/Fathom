// A plan's devices with what Termix needs (ADR-0080 decision 2): name and management address. Pure.

import { asString, fieldValue, findNode, type Document } from '../../document/model';

export interface ReachableDevice {
  id: string;
  name: string;
  /** The management address as typed, or '' when the device has none. */
  address: string;
}

/** Each device, with its management address read from the design. Order kept; unknown ids skipped. */
export function reachable(doc: Document, devices: readonly { id: string; name: string }[]): ReachableDevice[] {
  return devices.flatMap((d) => {
    const n = findNode(doc, d.id);
    if (!n || n.absentSince !== undefined) return [];
    return [{ id: d.id, name: d.name, address: (asString(fieldValue(n.fields, 'Device.management_address')) ?? '').trim() }];
  });
}
