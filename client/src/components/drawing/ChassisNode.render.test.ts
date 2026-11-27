import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import { ChassisNode, type ChassisNodeData, type ChassisNodeType } from './ChassisNode';
import type { ChassisView, PortView } from './contract';
import { LiveStoreProvider, createLiveStore, type LiveState } from './liveStore';

// Render-to-string only, as `SurfaceNode.render.test.ts`: no DOM testing library is installed. What a press does
// where an undrawn port lies is driven in a browser (`scripts/drive-sample.mjs`).

function port(i: number, cabled: boolean): PortView {
  return {
    id: `sw-p${i}`,
    label: String(i),
    connector: 'rj45',
    row: 0,
    column: i,
    uplink: false,
    role: null,
    cable: cabled ? { cableId: 'k1', farPortId: 'far', farChassisId: 'c2', outsideCloset: false } : null,
    face: 'front',
    passThroughId: null,
  } as PortView;
}

const ports = [port(1, true), port(2, false)];

const chassis: ChassisView = {
  id: 'sw',
  deviceId: 'sw-device',
  hostname: 'switch-1',
  model: 'MODEL-X',
  vendor: 'vendor',
  positionU: 8,
  heightU: 1,
  face: 'front',
  ports,
  role: 'switch',
  managementAddress: null,
  serial: null,
  psuInlets: [],
  singleFed: false,
  oneFitted: false,
  placement: { kind: 'rack', rackId: 'r1', positionU: 8, face: 'front' },
  sketch: false,
};

function renderChassis(live: Partial<LiveState> = {}): string {
  const store = createLiveStore();
  store.setState(live);
  const data: ChassisNodeData = { chassis, ports, inlets: [], elevation: 'front', onSelectPort: () => {}, portSheath: new Map() };
  return renderToStaticMarkup(
    createElement(
      ReactFlowProvider,
      null,
      createElement(LiveStoreProvider, { value: store }, createElement(ChassisNode, { data } as unknown as NodeProps<ChassisNodeType>)),
    ),
  );
}

const layer = (markup: string) => markup.match(/class="(drawing-chassis__ports[^"]*)"/)?.[1];

describe('ChassisNode (render-to-string)', () => {
  // The style sheet hides a layer marked so (`visibility: hidden`), so nothing in it takes a pointer. An undrawn
  // port once took the press meant for its device, and a drag from a free one drew a cable from a port nobody
  // could see.
  it('marks its ports out of reach until the camera is close enough to draw them', () => {
    const far = renderChassis();
    expect(layer(far)).toBe('drawing-chassis__ports drawing-chassis__ports--undrawn');
    // Each keeps its place and its handle, so a cable still ends where its port is.
    expect(far).toMatch(/<div data-port-id="sw-p1" class="drawing-chassis__port drawing-chassis__port--bare"/);
    expect(far).toMatch(/<div data-port-id="sw-p2" class="drawing-chassis__port drawing-chassis__port--bare"/);
    expect(far.match(/drawing-chassis__port-handle/g)?.length).toBe(2);
    expect(far).not.toContain('<button');
  });

  it('draws each port as a button with its tip once the camera is close enough', () => {
    const near = renderChassis({ showPortGlyphs: true });
    expect(layer(near)).toBe('drawing-chassis__ports');
    expect(near).toMatch(/<button type="button" data-port-id="sw-p1" title="Port 1 · RJ45[^"]*cabled"/);
    expect(near).toMatch(/<button type="button" data-port-id="sw-p2" title="Port 2 · RJ45[^"]*free"/);
    expect(near).not.toContain('drawing-chassis__port--bare');
  });

  it('keeps the device name in reach at every zoom', () => {
    for (const markup of [renderChassis(), renderChassis({ showPortGlyphs: true })]) {
      expect(markup).toContain('switch-1');
      expect(markup.indexOf('switch-1')).toBeLessThan(markup.indexOf('drawing-chassis__ports'));
    }
  });
});
