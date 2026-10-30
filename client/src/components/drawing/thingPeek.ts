// Sign-off r59: what the hover peek says about a device, a rack, a shelf or a cable, the way `portPeek.ts`
// does for a port. It replaces the callout a click on a device's name used to draw: a click now always
// opens the panel, and a pause over anything says what it is first. Pure; the card is `PortPeek.tsx`.

import { deviceNameIndex } from './cableGroups';
import { UNNAMED_HOSTNAME, type ClosetView } from './contract';
import { findChassis, findFixture, findOccupant, findShelf, findUnplacedChassis, locatePort } from './lookup';

export interface ThingRow {
  key: string;
  value: string;
  empty: boolean;
}

export interface ThingPeekCard {
  title: string;
  rows: ThingRow[];
}

export type PeekTarget = { kind: 'device' | 'rack' | 'shelf' | 'cable'; id: string };

const row = (key: string, value: string | null | undefined, none: string): ThingRow =>
  value != null && value.trim() !== '' ? { key, value, empty: false } : { key, value: none, empty: true };

const units = (positionU: number, heightU: number) => (heightU <= 1 ? `U${positionU}` : `U${positionU}–U${positionU + heightU - 1}`);

export function thingPeek(view: ClosetView, target: PeekTarget): ThingPeekCard | null {
  switch (target.kind) {
    case 'device':
      return devicePeek(view, target.id);
    case 'rack':
      return rackPeek(view, target.id);
    case 'shelf':
      return shelfPeek(view, target.id);
    case 'cable':
      return cablePeek(view, target.id);
  }
}

function devicePeek(view: ClosetView, id: string): ThingPeekCard | null {
  const racked = findChassis(view, id);
  const chassis = racked?.chassis ?? findUnplacedChassis(view, id);
  if (chassis != null) {
    const cabled = chassis.ports.filter((p) => p.cable != null).length;
    return {
      title: chassis.hostname || UNNAMED_HOSTNAME,
      rows: [
        row('Model', [chassis.vendor, chassis.model].filter(Boolean).join(' '), 'Typed by hand'),
        row('Where', racked ? `${racked.rack.label} · ${units(chassis.positionU, chassis.heightU)}` : null, 'Not placed'),
        row('Address', chassis.managementAddress, 'No address'),
        row('Ports', chassis.ports.length > 0 ? `${cabled} of ${chassis.ports.length} cabled` : null, 'No ports'),
      ],
    };
  }
  const occ = findOccupant(view, id);
  if (occ != null) {
    const cabled = occ.occupant.ports.filter((p) => p.cable != null).length;
    return {
      title: occ.occupant.label || UNNAMED_HOSTNAME,
      rows: [
        row('Model', occ.occupant.model, 'Typed by hand'),
        row('Where', `${occ.rack.label} · ${occ.shelf.label || 'shelf'}`, 'Not placed'),
        row('Ports', occ.occupant.ports.length > 0 ? `${cabled} of ${occ.occupant.ports.length} cabled` : null, 'No ports'),
      ],
    };
  }
  const fix = findFixture(view, id);
  if (fix != null) {
    return {
      title: fix.fixture.label || UNNAMED_HOSTNAME,
      rows: [row('Model', fix.fixture.model, 'Typed by hand'), row('Where', fix.surface.label, 'Not placed')],
    };
  }
  const box = view.free.find((f) => f.id === id);
  if (box != null) {
    return {
      title: box.hostname || UNNAMED_HOSTNAME,
      rows: [row('Model', box.model, 'Typed by hand'), row('Role', box.role, 'No role'), row('Ports', box.portCount > 0 ? String(box.portCount) : null, 'No ports')],
    };
  }
  return null;
}

function rackPeek(view: ClosetView, id: string): ThingPeekCard | null {
  const rack = view.racks.find((r) => r.id === id);
  if (rack == null) return null;
  const used = rack.chassis.reduce((n, c) => n + c.heightU, 0) + (rack.shelves ?? []).reduce((n, s) => n + s.heightU, 0);
  const devices = rack.chassis.length + (rack.shelves ?? []).reduce((n, s) => n + s.occupants.length, 0);
  return {
    title: rack.label || 'Rack',
    rows: [
      row('Size', `${rack.heightU}U`, ''),
      row('Used', `${used}U used · ${Math.max(0, rack.heightU - used)}U free`, ''),
      row('Devices', devices > 0 ? String(devices) : null, 'Empty'),
      row('Row', rack.row, 'No row'),
    ],
  };
}

function shelfPeek(view: ClosetView, id: string): ThingPeekCard | null {
  const found = findShelf(view, id);
  if (found == null) return null;
  const { rack, shelf } = found;
  const on = shelf.occupants.map((o) => o.label).filter(Boolean);
  return {
    title: shelf.label || 'Shelf',
    rows: [
      row('Where', `${rack.label} · ${units(shelf.positionU, shelf.heightU)}`, ''),
      row('On it', on.length > 0 ? (on.length > 3 ? `${on.slice(0, 3).join(', ')} and ${on.length - 3} more` : on.join(', ')) : null, 'Nothing yet'),
    ],
  };
}

function cablePeek(view: ClosetView, id: string): ThingPeekCard | null {
  const cable = view.cables.find((c) => c.id === id);
  if (cable == null) return null;
  const names = deviceNameIndex(view);
  const endWords = cable.ends.map((end) => {
    if ('outside' in end) return end.label !== '' ? end.label : 'Leaves this room';
    const port = locatePort(view, end.portId)?.port;
    const portLabel = port == null ? '' : 'slot' in port && typeof port.slot === 'string' && port.slot !== '' ? port.slot : port.label;
    return [names.get(end.chassisId), portLabel].filter((s): s is string => s != null && s !== '').join(' · ');
  });
  const title = (cable.label ?? '').trim() !== '' ? cable.label!.trim() : cable.media !== '' ? cable.media : 'Cable';
  return {
    title,
    rows: [
      row('From', endWords[0], 'Not connected'),
      row('To', endWords[1], cable.looseEnd ? 'Not connected yet' : 'Not connected'),
      row('Kind', [cable.media, cable.sheath].filter(Boolean).join(' · '), 'Not recorded'),
      row('Length', cable.lengthM != null ? `${cable.lengthM} m` : null, 'Not recorded'),
    ],
  };
}
