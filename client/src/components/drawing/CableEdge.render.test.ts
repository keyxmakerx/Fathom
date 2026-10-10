import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Position, ReactFlowProvider, type EdgeProps } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import type { CableView } from './contract';
import { CableEdge, type CableEdgeData, type CableEdgeType } from './CableEdge';
import { CableCrossingKeys, CableOverlayEdge } from './CableOverlayEdge';
import type { CableStyle } from './cableStyle';
import { createLiveStore, LiveStoreProvider, type LiveState, type LiveStore } from './liveStore';

// Render-to-string, as `SurfaceNode.render.test.ts` does (no DOM testing library is installed).

const cable: CableView = { id: 'c1', kind: 'copper', media: 'cat6', sheath: 'blue', label: null, ends: [] };

function data(extra: Partial<CableEdgeData> = {}): CableEdgeData {
  return {
    cable,
    onSelect: () => {},
    onHoverChange: () => {},
    ends: [
      { x: 0, y: 0, w: 8, h: 6 },
      { x: 300, y: 300, w: 8, h: 6 },
    ],
    ...extra,
  };
}

function wrap(store: LiveStore, child: ReactNode): string {
  return renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(LiveStoreProvider, { value: store }, child)));
}

function renderCable(style: CableStyle, state: Partial<LiveState> = {}, extra: Partial<CableEdgeData> = {}): string {
  const store = createLiveStore();
  store.setState({ cableStyle: style, ...state });
  const props = {
    id: 'c1',
    source: 'a',
    target: 'b',
    sourceX: 4,
    sourceY: 6,
    targetX: 304,
    targetY: 300,
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
    data: data(extra),
  } as unknown as EdgeProps<CableEdgeType>;
  return wrap(store, createElement(CableEdge, props));
}

function mainPath(html: string): string {
  const m = /<g id="cable-v-c1">.*?<path d="([^"]+)"/.exec(html);
  return m?.[1] ?? '';
}

describe('cable styles on the canvas', () => {
  it('physics draws one sagging curve', () => {
    const html = renderCable('physics');
    expect(html).toContain('data-cable-style="physics"');
    expect(mainPath(html)).toMatch(/^M 4 6 C /);
  });
  it('right-angle draws straight runs only', () => {
    const d = mainPath(renderCable('square'));
    expect(d).toMatch(/^M 4 6 L /);
    expect(d).not.toContain('C');
  });
  it('cable-tied draws its ties when it carries them', () => {
    const html = renderCable("tied", {}, { ties: [{ x1: 0, y1: 50, x2: 10, y2: 50 }] });
    expect(html).toContain('drawing-cable__tie');
  });
  it('faded draws two fading tips and a ghost, not the whole line', () => {
    const html = renderCable('faded');
    expect(html).toContain('cable-fade-c1-0');
    expect(html).toContain('cable-fade-c1-1');
    expect(html).toContain('drawing-cable__ghost');
    expect(html).toContain('drawing-cable--faded');
  });
  it('faded shows the whole line at once while pointed at', () => {
    const html = renderCable('faded', { hoveredCableId: 'c1' });
    expect(html).not.toContain('cable-fade-c1-0');
  });
  it('faded keeps a selected cable whole', () => {
    const html = renderCable('faded', { litCableId: 'c1', litCableIdSet: new Set(['c1']) });
    expect(html).not.toContain('cable-fade-c1-0');
  });
  it('the cable pointed at never dims beside a selected one', () => {
    const html = renderCable('physics', { litCableId: 'other', litCableIdSet: new Set(['other']), hoveredCableId: 'c1' });
    expect(html).toContain('opacity:1');
  });
  it('another cable dims while one is pointed at', () => {
    const html = renderCable('physics', { litCableId: 'other', litCableIdSet: new Set(['other']), hoveredCableId: 'other' });
    expect(html).toContain('opacity:var(--phantom)');
  });
});

describe('the top cable layer', () => {
  it('repeats the pointed-at cable above the rest, taking no pointer events', () => {
    const store = createLiveStore();
    store.setState({ hoveredCableId: 'c2', litCableId: 'c9' });
    const html = wrap(store, createElement(CableOverlayEdge));
    expect(html).toContain('href="#cable-v-c2"');
    expect(html).toContain('pointer-events="none"');
  });
  it('falls back to the selected cable, and draws nothing with neither', () => {
    const store = createLiveStore();
    store.setState({ litCableId: 'c9' });
    expect(wrap(store, createElement(CableOverlayEdge))).toContain('href="#cable-v-c9"');
    expect(wrap(createLiveStore(), createElement(CableOverlayEdge))).toBe('');
  });
  it('says how many cables cross under the pointer and which is lit', () => {
    const store = createLiveStore();
    store.setState({ hoverStack: ['a', 'b', 'c'], hoveredCableId: 'b' });
    expect(wrap(store, createElement(CableCrossingKeys))).toContain('3 cables here · 2 of 3 · Tab for the next');
    store.setState({ hoverStack: ['a'] });
    expect(wrap(store, createElement(CableCrossingKeys))).toBe('');
  });
});

describe('ties belong to the cable-tied style', () => {
  it('draws no ties in another style, even if handed some', () => {
    expect(renderCable('square', {}, { ties: [{ x1: 0, y1: 50, x2: 10, y2: 50 }] })).not.toContain('drawing-cable__tie');
  });
});
