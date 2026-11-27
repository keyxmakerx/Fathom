import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import type { FixtureView, SurfaceView } from '../../document/view';
import type { InletView, PortView } from './contract';
import { LiveStoreProvider, createLiveStore, type LiveState } from './liveStore';
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

// `liveDrag`/`litCableId` live in `liveStore.ts`, not on `data` — a fresh,
// empty store gives every test below `liveDrag: null`, `litCableId: null`.
// `live` sets what a test needs of it, such as the camera being close enough for ports to be drawn.
function renderSurface(data: SurfaceNodeData, live: Partial<LiveState> = {}): string {
  const store = createLiveStore();
  store.setState(live);
  return renderToStaticMarkup(
    createElement(
      ReactFlowProvider,
      null,
      createElement(
        LiveStoreProvider,
        { value: store },
        createElement(SurfaceNode, { data } as unknown as NodeProps<SurfaceNodeType>),
      ),
    ),
  );
}

const noop = () => {};

function baseData(overrides: Partial<SurfaceNodeData> & Pick<SurfaceNodeData, 'placement'>): SurfaceNodeData {
  return {
    uPx: U_PX,
    onSelectPort: noop,
    onSelectFixture: noop,
    portSheath: new Map(),
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

  it('a selected fixture is marked, whether the selection names it a fixture or a chassis, and no other is', () => {
    const cam = fixture({ id: 'cam-1', label: 'camera-1', kind: 'chassis', xMm: 0, yMm: 0 });
    const other = fixture({ id: 'cam-2', label: 'camera-2', kind: 'chassis', xMm: 600, yMm: 0 });
    const s = surface({ id: 'wall-out', label: 'Outside wall', form: 'wall', fixtures: [cam, other] });
    const marked = (markup: string) => [...markup.matchAll(/data-device-chassis="([^"]+)" class="([^"]*)"/g)].filter((m) => m[2]!.includes('drawing-surface__fixture--selected')).map((m) => m[1]);
    expect(marked(renderSurface(baseData({ placement: placement(s) })))).toEqual([]);
    expect(marked(renderSurface(baseData({ placement: placement(s) }), { selected: { kind: 'fixture', id: 'cam-1' } }))).toEqual(['cam-1']);
    expect(marked(renderSurface(baseData({ placement: placement(s) }), { selected: { kind: 'chassis', id: 'cam-2' } }))).toEqual(['cam-2']);
    expect(marked(renderSurface(baseData({ placement: placement(s) }), { selected: { kind: 'rack', id: 'cam-1' } }))).toEqual([]);
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

  it("a fixture's ports draw with real handles, at whatever portOpacity the current zoom gives", () => {
    const f = fixture({
      id: 'outlet-w1',
      label: 'outlet-w1',
      xMm: 0,
      yMm: 0,
      ports: [port({ id: 'outlet-port-1', label: '1' })],
    });
    const s = surface({ id: 'wall-west', label: 'west wall', form: 'wall', fixtures: [f] });
    const markup = renderSurface(baseData({ placement: placement(s) }));
    expect(markup).toContain('data-port-id="outlet-port-1"');
  });

  it("a fixture's port says what it is, as the button's tip and as its name: a rack port's words", () => {
    const cable = { cableId: 'c1', farPortId: 'far', farChassisId: 'sw-01', outsideCloset: false };
    const f = fixture({
      id: 'switch-2',
      label: 'switch-2',
      xMm: 0,
      yMm: 0,
      ports: [port({ id: 'sw2-1', label: '1', cable }), port({ id: 'sw2-4', label: '4' })],
    });
    const s = surface({ id: 'wall-office', label: 'Office', form: 'wall', fixtures: [f] });
    const markup = renderSurface(baseData({ placement: placement(s) }), { showPortGlyphs: true });
    // The tip is on the button; the name comes from the picture inside it, in the same words.
    expect(markup).toMatch(/<button type="button" data-port-id="sw2-1" title="Port 1 · RJ45 · cabled"[^>]*>\s*<svg[^>]*role="img" aria-label="Port 1 · RJ45 · cabled"/);
    expect(markup).toMatch(/<button type="button" data-port-id="sw2-4" title="Port 4 · RJ45 · free"[^>]*>\s*<svg[^>]*role="img" aria-label="Port 4 · RJ45 · free"/);
    // Not the bare label alone, which said "1".
    expect(markup).not.toContain('aria-label="1"');
    expect(markup).not.toContain('aria-label="4"');
  });

  it("a fixture's port has no tip while the camera is too far out for it to be drawn, and keeps its name", () => {
    const f = fixture({ id: 'switch-2', label: 'switch-2', xMm: 0, yMm: 0, ports: [port({ id: 'sw2-4', label: '4' })] });
    const s = surface({ id: 'wall-office', label: 'Office', form: 'wall', fixtures: [f] });
    const markup = renderSurface(baseData({ placement: placement(s) }));
    expect(markup).toMatch(/<button type="button" data-port-id="sw2-4" class="[^"]*"[^>]*>\s*<svg[^>]*role="img" aria-label="Port 4 · RJ45 · free"/);
    expect(markup).not.toContain('title="Port 4');
  });

  // The style sheet hides a row marked so (`visibility: hidden`): its buttons take no Tab stop and no press, and
  // nothing in it is read out. A wall port that was not drawn once took both, and a press there jumped the zoom.
  it("a fixture's ports and inlets are marked out of reach until the camera is close enough to draw them", () => {
    const f = fixture({ id: 'ups-1', label: 'ups-1', xMm: 0, yMm: 0, ports: [port({ id: 'ups-eth', label: 'eth0' })], psuInlets: [inlet({ id: 'ups-in', label: 'inlet', slot: 'PSU1' })] });
    const s = surface({ id: 'wall-office', label: 'Office', form: 'wall', fixtures: [f] });
    const rows = (markup: string) => [...markup.matchAll(/class="(drawing-surface__port-row[^"]*)"/g)].map((m) => m[1]);
    expect(rows(renderSurface(baseData({ placement: placement(s) })))).toEqual(['drawing-surface__port-row drawing-surface__port-row--undrawn', 'drawing-surface__port-row drawing-surface__port-row--undrawn']);
    expect(rows(renderSurface(baseData({ placement: placement(s) }), { showPortGlyphs: true }))).toEqual(['drawing-surface__port-row', 'drawing-surface__port-row']);
  });

  it("a fixture's inlet has its tip on the button too, in the words its picture has", () => {
    const f = fixture({
      id: 'ont-01',
      label: 'ont-01',
      xMm: 0,
      yMm: 0,
      psuInlets: [inlet({ id: 'ont-inlet-1', label: 'inlet', slot: 'PSU1' }), inlet({ id: 'ont-inlet-2', label: 'inlet', slot: 'PSU2', fitted: false })],
    });
    const s = surface({ id: 'wall-west', label: 'west wall', form: 'wall', fixtures: [f] });
    const markup = renderSurface(baseData({ placement: placement(s) }));
    expect(markup).toMatch(/<button type="button" data-port-id="ont-inlet-1" title="PSU1 — fitted, no lead"[^>]*>\s*<svg[^>]*aria-label="PSU1 — fitted, no lead"/);
    expect(markup).toMatch(/<button type="button" data-port-id="ont-inlet-2" title="PSU2 — not fitted"[^>]*>\s*<svg[^>]*aria-label="PSU2 — not fitted"/);
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
    const markup = renderSurface(baseData({ placement: placement(s) }));
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

  // A board fixed with no position still
  // shows what it carries: the "not measured" strip draws it as its own
  // box with its own fixtures inside, never as a bare name.
  it('an unmeasured board draws as its own box with its nested fixtures, not a bare name, in the "not measured" strip', () => {
    const nid = fixture({ id: 'nid-01', label: 'nid-01', xMm: 50, yMm: 60 });
    const board = fixture({ id: 'board-w1', label: 'BOARD-W1', form: 'board', fixtures: [nid] });
    const s = surface({ id: 'wall-west', label: 'west wall', form: 'wall', fixtures: [board] });
    const markup = renderSurface(baseData({ placement: placement(s) }));
    expect(markup).toContain('drawing-surface__unmeasured');
    expect(markup).toContain('not measured');
    expect(markup).toContain('drawing-surface__board');
    expect(markup).toContain('BOARD-W1');
    expect(markup).toContain('nid-01');
    // Not a bare `drawing-surface__unmeasured-name` entry — that class
    // names ONLY the plain-name fallback every other unmeasured fixture
    // still gets.
    expect(markup).not.toContain('drawing-surface__unmeasured-name');
  });

  it('an unmeasured floor board also draws as its own box, not a bare name', () => {
    const nid = fixture({ id: 'nid-01', label: 'nid-01', xMm: 50, yMm: 60 });
    const board = fixture({ id: 'board-f1', label: 'BOARD-F1', form: 'board', fixtures: [nid] });
    const s = surface({ id: 'floor-1', label: 'floor', form: 'floor', fixtures: [board] });
    const markup = renderSurface(baseData({ placement: placement(s) }));
    expect(markup).toContain('drawing-surface__board');
    expect(markup).toContain('BOARD-F1');
    expect(markup).toContain('nid-01');
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
