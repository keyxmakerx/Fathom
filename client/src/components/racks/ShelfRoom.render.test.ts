import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ClosetView, OccupantView, PortView, RackView, ShelfView } from '../../document/view';
import { ShelfRoom } from './ShelfRoom';

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

function render(shelf: ShelfView, selected: Parameters<typeof ShelfRoom>[0]['selected'] = null, writer = false): string {
  return renderToStaticMarkup(
    createElement(ShelfRoom, {
      view: viewWith(shelf),
      shelfId: shelf.id,
      selected,
      paused: false,
      onSelect: noop,
      onOpenDevice: noop,
      onBack: noop,
      ...(writer ? { onArrange: noop } : {}),
    }),
  );
}

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
    expect(markup).toContain('SHELF 1U · Rack 1 U20 · 2 on it');
  });

  it('draws every thing on the shelf, with its model and its front ports', () => {
    const markup = render(shelf);
    expect(markup).toContain('padparadscha');
    expect(markup).toContain('NUC 13');
    expect(markup).toContain('data-occupant-id="outlets"');
    expect(markup).toContain('data-port-id="eth0"');
    expect(markup).toContain('to another closet');
  });

  it('draws every thing even when none has a slot (they all read as slot 0)', () => {
    const markup = render({ ...shelf, slots: null, occupants: [occupant('a', 0), occupant('b', 0), occupant('c', 0)] });
    for (const id of ['a', 'b', 'c']) expect(markup).toContain(`data-occupant-id="${id}"`);
  });

  it('a cable between two things on the shelf hangs between their ports, with no tag', () => {
    const cable = (far: string) => ({ cableId: 'c9', farPortId: far, farChassisId: null, outsideCloset: false });
    const markup = render({
      ...shelf,
      occupants: [occupant('sw', 1, { ports: [port('p1', { cable: cable('p2') })] }), occupant('pc', 2, { ports: [port('p2', { cable: cable('p1') })] })],
    });
    expect(markup.match(/shelf-room__cable/g)?.length).toBe(1);
    expect(markup).not.toContain('shelf-room__tag');
  });

  it('from the front, a thing with only rear ports says they are on the back', () => {
    const rearOnly = occupant('nuc', 1, { ports: [port('lan', { face: 'rear' })] });
    const markup = render({ ...shelf, occupants: [rearOnly] });
    expect(markup).not.toContain('data-port-id="lan"');
    expect(markup).toContain('ports on the back');
  });

  it('marks the selected thing', () => {
    expect(render(shelf, { kind: 'occupant', id: 'padparadscha' })).toContain('shelf-room__thing--selected');
  });

  it('only a writer can drag, and is told how many are not placed by hand yet', () => {
    expect(render(shelf)).not.toContain('shelf-room__thing--movable');
    const markup = render(shelf, null, true);
    expect(markup).toContain('shelf-room__thing--movable');
    expect(markup).toContain('2 not placed by hand yet');
    expect(render({ ...shelf, occupants: shelf.occupants.map((o, i) => ({ ...o, xMm: i * 200 })) }, null, true)).not.toContain('not placed by hand');
  });

  it('draws the shelf twice, from above and from the front, joined by a line for each thing', () => {
    const markup = render(shelf);
    expect(markup).toContain('FROM ABOVE');
    expect(markup).toContain('FROM THE FRONT');
    expect(markup).toContain('data-plan-id="padparadscha"');
    expect(markup).toContain('data-guide-for="padparadscha"');
    expect(markup).toContain('data-guide-for="outlets"');
  });

  it('a size from the catalogue is drawn solid, a guessed one dashed', () => {
    const sized = { ...shelf, occupants: [occupant('sw', 1, { model: 'TL-SG108E', sizeMm: { widthMm: 158, depthMm: 101, heightMm: 25 } }), occupant('guess', 2)] };
    const markup = render(sized);
    const frontOf = (id: string) => markup.slice(markup.indexOf(`data-occupant-id="${id}"`)).slice(0, 300);
    expect(frontOf('sw')).toContain('class="shelf-room__box"');
    expect(frontOf('guess')).toContain('shelf-room__box--guess');
  });

  it('a thing set back says how far, and is drawn behind', () => {
    const back = { ...shelf, occupants: [occupant('kvm', 1, { xMm: 0, yMm: 120 }), occupant('nuc', 2, { xMm: 0, yMm: 0 })] };
    const markup = render(back);
    expect(markup).toContain('120 mm back');
    const frontOf = (id: string) => markup.slice(markup.indexOf(`data-occupant-id="${id}"`) - 200, markup.indexOf(`data-occupant-id="${id}"`));
    expect(frontOf('kvm')).toContain('shelf-room__thing--set-back');
    expect(frontOf('nuc')).not.toContain('shelf-room__thing--set-back');
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

  it('draws an AI idea shown in the ideas panel: what it moves in the plan colour, and nothing to drag', () => {
    const placed = { ...shelf, occupants: shelf.occupants.map((o, i) => ({ ...o, xMm: i * 200 })) };
    const moved = { ...placed, occupants: placed.occupants.map((o) => (o.id === 'outlets' ? { ...o, xMm: 300, yMm: 40 } : o)) };
    const markup = renderToStaticMarkup(
      createElement(ShelfRoom, { view: viewWith(placed), proposed: viewWith(moved), shelfId: 's1', selected: null, paused: false, onSelect: noop, onOpenDevice: noop, onBack: noop, onArrange: noop }),
    );
    expect(markup).toContain('Showing an AI idea on this shelf: it moves or adds 1 thing');
    expect(markup).toContain('AI MOVES');
    expect(markup.match(/shelf-room__thing--ai/g)?.length).toBe(2);
    expect(markup).not.toContain('shelf-room__thing--movable');
  });
});
