import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import type { FixtureView, SurfaceView } from '../../document/view';
import type { InletView, PortView } from './contract';
import type { SurfacePlacement } from './rows';
import { mmToPx } from './rows';
import { SurfaceNode, type SurfaceNodeData, type SurfaceNodeType } from './SurfaceNode';

// Render-to-string smoke tests only, per `ShelfPlate.render.test.ts`'s own
// precedent (that file's own note: no DOM testing library is installed).

const U_PX = 16;
const PANEL_HEIGHT_PX = 400;

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

function inlet(overrides: Partial<InletView> & Pick<InletView, 'id' | 'label'>): InletView {
  return {
    connector: 'c14',
    row: 0,
    column: 0,
    uplink: false,
    role: null,
    cable: null,
    face: 'front',
    passThroughId: null,
    slot: overrides.id,
    hotSwap: true,
    fitted: true,
    supplyId: null,
    serial: null,
    model: null,
    position: { row: 'single', column: 0 },
    ...overrides,
  };
}

function fixture(overrides: Partial<FixtureView> & Pick<FixtureView, 'id' | 'label'>): FixtureView {
  return {
    kind: 'passive',
    model: null,
    form: null,
    xMm: null,
    yMm: null,
    ports: [],
    psuInlets: [],
    fixtures: [],
    ...overrides,
  };
}

function surface(overrides: Partial<SurfaceView> & Pick<SurfaceView, 'id' | 'label' | 'form'>): SurfaceView {
  return { widthMm: null, heightMm: null, fixtures: [], ...overrides };
}

function placement(s: SurfaceView, overrides: Partial<SurfacePlacement> = {}): SurfacePlacement {
  return { surface: s, x: 0, y: 0, widthPx: 340, heightPx: PANEL_HEIGHT_PX, ...overrides };
}

function renderSurface(data: SurfaceNodeData): string {
  return renderToStaticMarkup(
    createElement(ReactFlowProvider, null, createElement(SurfaceNode, { data } as unknown as NodeProps<SurfaceNodeType>)),
  );
}

const noop = () => {};

function baseData(overrides: Partial<SurfaceNodeData> & Pick<SurfaceNodeData, 'placement'>): SurfaceNodeData {
  return {
    uPx: U_PX,
    onSelectPort: noop,
    onSelectFixture: noop,
    liveDrag: null,
    portSheath: new Map(),
    litCableId: null,
    portOpacity: 1,
    ...overrides,
  };
}

describe('SurfaceNode (render-to-string)', () => {
  it('draws the surface label and its form, uppercased', () => {
    const s = surface({ id: 'wall-west', label: 'west wall', form: 'wall' });
    const markup = renderSurface(baseData({ placement: placement(s) }));
    expect(markup).toContain('west wall');
    expect(markup).toContain('WALL');
  });

  it('names "no rear · no flip" on every panel (ADR-0051 §1/§2)', () => {
    const s = surface({ id: 'wall-west', label: 'west wall', form: 'wall' });
    const markup = renderSurface(baseData({ placement: placement(s) }));
    expect(markup).toContain('no rear');
    expect(markup).toContain('no flip');
  });

  it('draws the millimetre rail, starting at 0 (the floor)', () => {
    const s = surface({ id: 'wall-west', label: 'west wall', form: 'wall' });
    const markup = renderSurface(baseData({ placement: placement(s) }));
    expect(markup).toContain('drawing-surface__rail');
    expect(markup).toContain('drawing-surface__rail-tick');
    expect(markup).toContain('>0<');
  });

  it('a positioned fixture draws at xMm/yMm, scaled by the rack\'s own 44.45mm-per-U ruler', () => {
    const f = fixture({ id: 'ont-01', label: 'ont-01', xMm: 300, yMm: 900 });
    const s = surface({ id: 'wall-west', label: 'west wall', form: 'wall', fixtures: [f] });
    const markup = renderSurface(baseData({ placement: placement(s) }));
    expect(markup).toContain('ont-01');
    expect(markup).toContain(`left:${mmToPx(300, U_PX)}px`);
    expect(markup).toContain(`bottom:${mmToPx(900, U_PX)}px`);
  });

  it('a fixture with no position sits in the "not measured" strip at the panel\'s foot, named', () => {
    const f = fixture({ id: 'unplaced-01', label: 'unplaced-01' });
    const s = surface({ id: 'wall-west', label: 'west wall', form: 'wall', fixtures: [f] });
    const markup = renderSurface(baseData({ placement: placement(s) }));
    expect(markup).toContain('drawing-surface__unmeasured');
    expect(markup).toContain('not measured');
    expect(markup).toContain('unplaced-01');
    // Not drawn as a positioned anchor.
    expect(markup).not.toContain('drawing-surface__fixture-anchor');
  });

  it('a fixture with no catalogue entry (model: null) is marked typed, not blank', () => {
    const f = fixture({ id: 'nuc-01', label: 'nuc-01', xMm: 0, yMm: 0, model: null });
    const s = surface({ id: 'wall-west', label: 'west wall', form: 'wall', fixtures: [f] });
    const markup = renderSurface(baseData({ placement: placement(s) }));
    expect(markup).toContain('drawing-surface__typed');
    expect(markup).toContain('no catalogue entry');
  });

  it('a fixture with a catalogue model shows the model, not the typed mark', () => {
    const f = fixture({ id: 'ont-01', label: 'ont-01', xMm: 0, yMm: 0, model: 'ONT-500' });
    const s = surface({ id: 'wall-west', label: 'west wall', form: 'wall', fixtures: [f] });
    const markup = renderSurface(baseData({ placement: placement(s) }));
    expect(markup).toContain('ONT-500');
    expect(markup).not.toContain('drawing-surface__typed');
  });

  it("a fixture's ports draw with real handles, at portOpacity", () => {
    const f = fixture({
      id: 'outlet-w1',
      label: 'outlet-w1',
      xMm: 0,
      yMm: 0,
      ports: [port({ id: 'outlet-port-1', label: '1' })],
    });
    const s = surface({ id: 'wall-west', label: 'west wall', form: 'wall', fixtures: [f] });
    const markup = renderSurface(baseData({ placement: placement(s), portOpacity: 0.5 }));
    expect(markup).toContain('data-port-id="outlet-port-1"');
  });

  it("a fixture's own PSU inlets always draw, regardless of portOpacity", () => {
    const f = fixture({
      id: 'ont-01',
      label: 'ont-01',
      xMm: 0,
      yMm: 0,
      psuInlets: [inlet({ id: 'ont-inlet-1', label: 'inlet' })],
    });
    const s = surface({ id: 'wall-west', label: 'west wall', form: 'wall', fixtures: [f] });
    const markup = renderSurface(baseData({ placement: placement(s), portOpacity: 0 }));
    expect(markup).toContain('data-port-id="ont-inlet-1"');
  });

  it('single-fed and one-fitted washes draw exactly as a chassis has them — the SAME bordered wash class', () => {
    const fed = { cableId: 'c0', farPortId: 'far', farChassisId: 'far-c', outsideCloset: false };
    const f = fixture({
      id: 'ups-01',
      label: 'ups-01',
      xMm: 0,
      yMm: 0,
      psuInlets: [inlet({ id: 'i1', label: 'inlet1', cable: fed }), inlet({ id: 'i2', label: 'inlet2', cable: null })],
    });
    const s = surface({ id: 'floor-1', label: 'floor', form: 'floor', fixtures: [f] });
    const markup = renderSurface(baseData({ placement: placement(s) }));
    expect(markup).toContain('drawing-chassis__single-fed');
    expect(markup).toContain('single-fed');
  });

  it('a board draws as a labelled rectangle carrying its own nested fixtures', () => {
    const nid = fixture({ id: 'nid-01', label: 'nid-01', xMm: 50, yMm: 50 });
    const board = fixture({ id: 'board-w1', label: 'BOARD-W1', form: 'board', xMm: 100, yMm: 900, fixtures: [nid] });
    const s = surface({ id: 'wall-west', label: 'west wall', form: 'wall', fixtures: [board] });
    const markup = renderSurface(baseData({ placement: placement(s) }));
    expect(markup).toContain('drawing-surface__board');
    expect(markup).toContain('BOARD-W1');
    expect(markup).toContain('nid-01');
  });

  it('a board child fixture positions from the BOARD\'s own edges, not the wall\'s', () => {
    const nid = fixture({ id: 'nid-01', label: 'nid-01', xMm: 50, yMm: 60 });
    const board = fixture({ id: 'board-w1', label: 'BOARD-W1', form: 'board', xMm: 100, yMm: 900, fixtures: [nid] });
    const s = surface({ id: 'wall-west', label: 'west wall', form: 'wall', fixtures: [board] });
    const markup = renderSurface(baseData({ placement: placement(s) }));
    expect(markup).toContain(`left:${mmToPx(50, U_PX)}px`);
    expect(markup).toContain(`bottom:${mmToPx(60, U_PX)}px`);
  });

  it('the floor draws as a band, no millimetre rail, fixtures standing upright', () => {
    const ups = fixture({ id: 'ups-01', label: 'ups-01', xMm: 800, yMm: null });
    const s = surface({ id: 'floor-1', label: 'floor', form: 'floor', fixtures: [ups] });
    const markup = renderSurface(baseData({ placement: placement(s) }));
    expect(markup).toContain('drawing-surface--floor');
    expect(markup).toContain('ups-01');
    expect(markup).not.toContain('drawing-surface__rail');
    expect(markup).toContain('drawing-surface__fixture--upright');
  });

  it('the floor still stands an unmeasured fixture, never dropping it for want of xMm', () => {
    const ups = fixture({ id: 'ups-01', label: 'ups-01', xMm: null, yMm: null });
    const s = surface({ id: 'floor-1', label: 'floor', form: 'floor', fixtures: [ups] });
    const markup = renderSurface(baseData({ placement: placement(s) }));
    expect(markup).toContain('ups-01');
  });

  it('two unmeasured floor fixtures both sit in the named "not measured" strip, never at distinct invented offsets', () => {
    const a = fixture({ id: 'ups-a', label: 'ups-a', xMm: null, yMm: null });
    const b = fixture({ id: 'ups-b', label: 'ups-b', xMm: null, yMm: null });
    const s = surface({ id: 'floor-1', label: 'floor', form: 'floor', fixtures: [a, b] });
    const markup = renderSurface(baseData({ placement: placement(s) }));
    expect(markup).toContain('not measured');
    expect(markup).not.toContain('drawing-surface__floor-anchor');
  });

  it('a floor fixture measured on xMm draws in the stage, not the "not measured" strip', () => {
    const ups = fixture({ id: 'ups-01', label: 'ups-01', xMm: 800, yMm: null });
    const s = surface({ id: 'floor-1', label: 'floor', form: 'floor', fixtures: [ups] });
    const markup = renderSurface(baseData({ placement: placement(s) }));
    expect(markup).toContain('drawing-surface__floor-anchor');
    expect(markup).not.toContain('not measured');
  });

  it('a panel fixture measured on xMm only still positions (from the measured axis), not dropped to the "not measured" strip', () => {
    const nid = fixture({ id: 'nid-01', label: 'nid-01', xMm: 300, yMm: null });
    const s = surface({ id: 'wall-1', label: 'wall', form: 'wall', fixtures: [nid] });
    const markup = renderSurface(baseData({ placement: placement(s) }));
    expect(markup).toContain(`left:${mmToPx(300, U_PX)}px`);
    expect(markup).toContain('bottom:0"');
    expect(markup).not.toContain('drawing-surface__unmeasured-name');
    expect(markup).toContain('y not measured');
  });
});
