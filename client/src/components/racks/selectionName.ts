// The short name of what is selected, for the trail of where you have been ("R1", "SWITCH-1").

import type { ClosetView } from '../drawing/contract';
import { findFixture, findOccupant, findRack, findShelf, locatePort } from '../drawing/lookup';
import { deviceChassis } from '../jot/jotLayout';

export function selectionName(view: ClosetView, selection: { kind: string; id: string } | null): string {
  if (selection == null) return '';
  const { kind, id } = selection;
  switch (kind) {
    case 'rack':
      return findRack(view, id)?.label ?? 'Rack';
    case 'chassis': {
      const chassis = deviceChassis(view, id);
      return chassis == null ? 'Device' : chassis.hostname !== '' ? chassis.hostname : 'Unnamed device';
    }
    case 'shelf':
      return findShelf(view, id)?.shelf.label || 'Shelf';
    case 'occupant':
      return findOccupant(view, id)?.occupant.label || 'Device';
    case 'fixture':
      return findFixture(view, id)?.fixture.label || 'Fixture';
    case 'port': {
      const port = locatePort(view, id)?.port;
      return port?.label ? port.label : 'Port';
    }
    case 'cable':
      return (view.cables ?? []).find((c) => c.id === id)?.label || 'Cable';
    case 'label': {
      const text = (view.labels ?? []).find((l) => l.id === id)?.text ?? '';
      return text.trim() === '' ? 'Label' : text.trim().slice(0, 24);
    }
    default:
      return 'Line';
  }
}
