import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import type { OccupantView, ShelfView } from '../../document/view';
import type { PortView } from './contract';
import { ShelfPlate, type ShelfPlateNodeData, type ShelfPlateNodeType } from './ShelfPlate';

// Render-to-string smoke tests only, per `ColourPicker.render.test.ts`'s own
// precedent — no DOM testing library is installed, so a click that opens the
// faceplate-stop inset is not exercised here (that needs `useViewport` to
// read a real, changing zoom, which only a DOM harness could drive); this
// checks the markup `ShelfPlate` produces at a given zoom and selection,
// which is what a render-to-string pass can actually see.

function port(overrides: Partial<PortView> & Pick<PortView, 'id' | 'label'>): PortView {
  return {
    connector: 'rj45',
    row: 0,
    column: 0,
    uplink: false,
    role: null,
    cable: null,
    face: 'front',
    passThroughId: null,
    ...overrides,
  };
}

function occupant(overrides: Partial<OccupantView> & Pick<OccupantView, 'id'>): OccupantView {
  return {
    kind: 'chassis',
    label: overrides.id,
    model: null,
    slot: 1,
    ports: [],
    sketch: false,
    ...overrides,
  };
}

function shelf(overrides: Partial<ShelfView> & Pick<ShelfView, 'id'>): ShelfView {
  return { label: overrides.id, positionU: 20, heightU: 2, occupants: [], ...overrides };
}

function renderShelf(data: ShelfPlateNodeData): string {
  return renderToStaticMarkup(
    createElement(
      ReactFlowProvider,
      null,
      createElement(ShelfPlate, { data } as unknown as NodeProps<ShelfPlateNodeType>),
    ),
  );
}

const noop = () => {};

function baseData(overrides: Partial<ShelfPlateNodeData> & Pick<ShelfPlateNodeData, 'shelf'>): ShelfPlateNodeData {
  return {
    elevation: 'front',
    selected: false,
    slotCount: null,
    selectedOccupantId: null,
    onSelectShelf: noop,
    onSelectOccupant: noop,
    onSelectPort: noop,
    liveDrag: null,
    portSheath: new Map(),
    litCableId: null,
    ...overrides,
  };
}

describe('ShelfPlate (render-to-string)', () => {
  it('draws the shelf label and "SHELF <height>U"', () => {
    const markup = renderShelf(baseData({ shelf: shelf({ id: 'shelf-a01', heightU: 2 }) }));
    expect(markup).toContain('shelf-a01');
    expect(markup).toContain('SHELF 2U');
  });

  it('draws occupants left to right by slot, each named', () => {
    const s = shelf({
      id: 'shelf-a01',
      occupants: [
        occupant({ id: 'nuc-01', slot: 1 }),
        occupant({ id: 'sw-desk-01', slot: 2 }),
        occupant({ id: 'ont-01', slot: 3 }),
      ],
    });
    const markup = renderShelf(baseData({ shelf: s }));
    const nucIndex = markup.indexOf('nuc-01');
    const swIndex = markup.indexOf('sw-desk-01');
    const ontIndex = markup.indexOf('ont-01');
    expect(nucIndex).toBeGreaterThan(-1);
    expect(swIndex).toBeGreaterThan(nucIndex);
    expect(ontIndex).toBeGreaterThan(swIndex);
  });

  it('marks a sketch occupant with the dotted "typed" badge, never a risk colour class', () => {
    const s = shelf({ id: 'shelf-a01', occupants: [occupant({ id: 'nuc-01', slot: 1, sketch: true })] });
    const markup = renderShelf(baseData({ shelf: s }));
    expect(markup).toContain('drawing-shelf__typed');
    expect(markup).toContain('typed');
  });

  it('a non-sketch occupant with a catalogue model shows the model, not the typed mark', () => {
    const s = shelf({
      id: 'shelf-a01',
      occupants: [occupant({ id: 'sw-desk-01', slot: 1, model: 'GS108', sketch: false })],
    });
    const markup = renderShelf(baseData({ shelf: s }));
    expect(markup).toContain('GS108');
    expect(markup).not.toContain('drawing-shelf__typed');
  });

  it('a patch-facing occupant (more than two ports) shows its ports at the rack stop', () => {
    const s = shelf({
      id: 'shelf-a01',
      occupants: [
        occupant({
          id: 'sw-desk-01',
          slot: 1,
          ports: [
            port({ id: 'p1', label: '1', face: 'front' }),
            port({ id: 'p2', label: '2', face: 'front' }),
            port({ id: 'p3', label: '3', face: 'front' }),
          ],
        }),
      ],
    });
    const markup = renderShelf(baseData({ shelf: s }));
    expect(markup).toContain('data-port-id="p1"');
    expect(markup).toContain('data-port-id="p2"');
    expect(markup).toContain('data-port-id="p3"');
  });

  it('a non-patch-facing occupant (two ports or fewer) shows no ports at the rack stop', () => {
    const s = shelf({
      id: 'shelf-a01',
      occupants: [
        occupant({
          id: 'nuc-01',
          slot: 1,
          ports: [port({ id: 'eth0', label: 'eth0', face: 'front' }), port({ id: 'eth1', label: 'eth1', face: 'front' })],
        }),
      ],
    });
    const markup = renderShelf(baseData({ shelf: s }));
    expect(markup).not.toContain('data-port-id="eth0"');
    expect(markup).not.toContain('data-port-id="eth1"');
  });

  it('an occupant with no PassiveNode ports (kind: passive) is always patch-facing, even with one port', () => {
    const s = shelf({
      id: 'shelf-a01',
      occupants: [occupant({ id: 'outlet-01', slot: 1, kind: 'passive', ports: [port({ id: 'a', label: 'A', face: 'front' })] })],
    });
    const markup = renderShelf(baseData({ shelf: s }));
    expect(markup).toContain('data-port-id="a"');
  });

  it('empty slots draw as hatched gaps when a slot count is given', () => {
    const s = shelf({ id: 'shelf-a01', occupants: [occupant({ id: 'nuc-01', slot: 1 })] });
    const markup = renderShelf(baseData({ shelf: s, slotCount: 4 }));
    expect((markup.match(/drawing-shelf__gap/g) ?? []).length).toBe(3);
  });

  it('without a slot count, only the occupants that exist draw — no gaps invented', () => {
    const s = shelf({ id: 'shelf-a01', occupants: [occupant({ id: 'nuc-01', slot: 1 }), occupant({ id: 'ont-01', slot: 3 })] });
    const markup = renderShelf(baseData({ shelf: s, slotCount: null }));
    expect(markup).not.toContain('drawing-shelf__gap');
  });

  it('the faceplate-stop inset does not open at the rack stop even when an occupant is selected', () => {
    const s = shelf({ id: 'shelf-a01', occupants: [occupant({ id: 'nuc-01', slot: 1 })] });
    const markup = renderShelf(baseData({ shelf: s, selectedOccupantId: 'nuc-01' }));
    expect(markup).not.toContain('drawing-shelf__inset');
  });

  it('selecting the shelf itself carries the selected modifier class', () => {
    const s = shelf({ id: 'shelf-a01' });
    const markup = renderShelf(baseData({ shelf: s, selected: true }));
    expect(markup).toContain('drawing-shelf--selected');
  });
});
