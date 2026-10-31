import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ClosetView, OccupantView, PortView, RackView, ShelfView } from '../../document/view';
import { ShelfRoom, shelfRoomSlots } from './ShelfRoom';

// Render-to-string only, as `ShelfPlate.render.test.ts` does: no DOM testing library is installed.

function port(id: string, overrides: Partial<PortView> = {}): PortView {
  return { id, label: id, connector: 'rj45', row: 0, column: 0, uplink: false, role: null, cable: null, face: 'front', passThroughId: null, ...overrides } as PortView;
}

function occupant(id: string, slot: number, overrides: Partial<OccupantView> = {}): OccupantView {
  return { id, kind: 'chassis', label: id, model: null, slot, ports: [], sketch: false, ...overrides };
}

function viewWith(shelf: ShelfView): ClosetView {
  const rack = { id: 'r1', label: 'Rack 1', heightU: 42, unitNumbering: 'bottom-up', chassis: [], shelves: [shelf], freeRuns: [], row: null, bay: null } as unknown as RackView;
  return { premisesId: 'p', racks: [rack], cables: [], rows: [], surfaces: [], unplaced: [], free: [], lines: [], labels: [] };
}

const noop = () => {};

function render(shelf: ShelfView, selected: Parameters<typeof ShelfRoom>[0]['selected'] = null): string {
  return renderToStaticMarkup(
    createElement(ShelfRoom, { view: viewWith(shelf), shelfId: shelf.id, selected, paused: false, onSelect: noop, onOpenDevice: noop, onBack: noop }),
  );
}

describe('shelfRoomSlots', () => {
  it('draws every slot of a shelf with a count, the empty ones too', () => {
    expect(shelfRoomSlots(4, [{ slot: 1 }, { slot: 3 }])).toEqual([1, 2, 3, 4]);
  });
  it('never hides a thing in a slot past the count', () => {
    expect(shelfRoomSlots(2, [{ slot: 3 }])).toEqual([1, 2, 3]);
  });
  it('without a count, only the slots in use', () => {
    expect(shelfRoomSlots(null, [{ slot: 5 }, { slot: 2 }])).toEqual([2, 5]);
  });
});

describe('ShelfRoom (render-to-string)', () => {
  const shelf: ShelfView = {
    id: 's1',
    label: 'Top shelf',
    positionU: 20,
    heightU: 1,
    slots: 3,
    occupants: [
      occupant('padparadscha', 1, { model: 'NUC 13', ports: [port('eth0'), port('eth1', { cable: { cableId: 'c1', farPortId: null, farChassisId: null, outsideCloset: true } })] }),
      occupant('outlets', 3, { kind: 'passive', label: 'outlets' }),
    ],
  };

  it('names the shelf and where it sits', () => {
    const markup = render(shelf);
    expect(markup).toContain('Top shelf');
    expect(markup).toContain('SHELF 1U · Rack 1 U20 · 2 on it · 1 slot free');
  });

  it('draws every thing whole, with its model and ports, and the empty slot hatched', () => {
    const markup = render(shelf);
    expect(markup).toContain('padparadscha');
    expect(markup).toContain('NUC 13');
    expect(markup).toContain('eth0');
    expect(markup).toContain('to another closet');
    expect(markup).toContain('shelf-room__gap');
    expect(markup).toContain('SLOT 2');
  });

  it('offers Open on a device only, not on a passive thing', () => {
    const markup = render(shelf);
    expect(markup.match(/shelf-room__open/g)?.length).toBe(1);
  });

  it('marks the selected thing', () => {
    expect(render(shelf, { kind: 'occupant', id: 'padparadscha' })).toContain('shelf-room__thing--selected');
  });

  it('says so when the shelf is gone', () => {
    const markup = renderToStaticMarkup(
      createElement(ShelfRoom, { view: viewWith(shelf), shelfId: 'nope', selected: null, paused: false, onSelect: noop, onOpenDevice: noop, onBack: noop }),
    );
    expect(markup).toContain('no longer in the design');
  });

  it('an empty shelf says so', () => {
    expect(render({ ...shelf, slots: null, occupants: [] })).toContain('Nothing on this shelf yet.');
  });
});
