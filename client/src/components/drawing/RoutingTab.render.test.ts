// The device panel's Routing tab (sign-off r101, option A). Render-to-string, as the other component tests are.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { addSketchPort, createSketchDevice } from '../../document/commands';
import { addAddress, interfaceChoices } from '../../document/ipam-write';
import { emptyDocument, parseNodeId, type Document } from '../../document/model';
import { addRoute, routingTable } from '../../document/routes';
import { RoutingContext, RoutingTab, type RoutingApi } from './RoutingTab';

function router(): { doc: Document; deviceId: string } {
  let doc = createSketchDevice(emptyDocument());
  const deviceId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Device')!.id;
  const chassisId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
  doc = addSketchPort(doc, chassisId, { label: 'ge-0/0/0', connector: 'rj45', face: 'front' });
  doc = addSketchPort(doc, chassisId, { label: 'ge-0/0/1', connector: 'rj45', face: 'front' });
  const owner = (label: string) => interfaceChoices(doc, deviceId).find((c) => c.label.startsWith(label))!;
  doc = addAddress(doc, { address: '10.0.1.1/24', owner: owner('ge-0/0/0') }, undefined);
  doc = addAddress(doc, { address: '203.0.113.2/30', owner: owner('ge-0/0/1') }, undefined);
  doc = addRoute(doc, { deviceId, destination: 'default', via: '203.0.113.1' }).doc;
  return { doc, deviceId };
}

const tab = (api: RoutingApi, deviceId: string) =>
  renderToStaticMarkup(createElement(RoutingContext.Provider, { value: api }, createElement(RoutingTab, { deviceId })));

describe('the Routing tab', () => {
  it('reads a device\'s table: connected networks, then static routes', () => {
    const r = router();
    const [t] = routingTable(r.doc, r.deviceId);
    expect(t!.name).toBe('default');
    expect(t!.connected.map((c) => c.network)).toEqual(['10.0.1.0/24', '203.0.113.0/30']);
    expect(t!.connected.map((c) => c.how)).toEqual(['connected, ge-0/0/0', 'connected, ge-0/0/1']);
    expect(t!.statics.map((s) => `${s.destination} ${s.via}`)).toEqual(['0.0.0.0/0 via 203.0.113.1']);
  });

  it('lists them with who wrote each, and offers Add route', () => {
    const r = router();
    const out = tab({ lit: true, doc: r.doc, applyDocChange: () => undefined }, r.deviceId);
    expect(out).toContain('Routing table');
    expect(out).toContain('10.0.1.0/24');
    expect(out).toContain('>default<');
    expect(out).toContain('via 203.0.113.1');
    expect(out).toContain('by hand');
    expect(out).toContain('Add route');
    expect(out).toContain('Not read yet');
  });

  it('gives a reader no Add route', () => {
    const r = router();
    const out = tab({ lit: true, doc: r.doc }, r.deviceId);
    expect(out).not.toContain('Add route');
  });
});
