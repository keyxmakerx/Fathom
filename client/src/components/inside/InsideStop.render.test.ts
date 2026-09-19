import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { InsideFaces, InsideInterface, InsidePolicy, InsidePolicySet, InsideRoute, InsideTunnel, InsideUnit, InsideZone } from '../../engine/engine';
import type { ChassisView, PortView } from '../../document/view';
import { InsideStop, type InsideStopProps } from './InsideStop';

// Render-to-string smoke tests only, per `ConfigDrawer.render.test.ts`'s own
// precedent — no DOM testing library is installed.

function port(overrides: Partial<PortView> & Pick<PortView, 'id' | 'label'>): PortView {
  return {
    connector: 'RJ45',
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

function chassis(overrides: Partial<ChassisView> = {}): ChassisView {
  return {
    id: 'chassis-1',
    deviceId: 'device-1',
    hostname: 'srx-branch-01',
    model: 'SRX340',
    vendor: 'juniper',
    positionU: 40,
    heightU: 2,
    face: 'front',
    ports: [
      port({ id: 'port-1', label: 'ge-0/0/0' }),
      port({ id: 'port-2', label: 'ge-0/0/1' }),
    ],
    role: null,
    managementAddress: null,
    serial: null,
    psuInlets: [],
    singleFed: false,
    oneFitted: false,
    placement: { kind: 'rack', rackId: 'rack-1', positionU: 40, face: 'front' },
    sketch: false,
    ...overrides,
  };
}

function unit(overrides: Partial<InsideUnit> & Pick<InsideUnit, 'id' | 'interfaceId' | 'label'>): InsideUnit {
  return { addresses: '', zoneId: '', zoneName: '', tunnel: '', ...overrides };
}

function iface(overrides: Partial<InsideInterface> & Pick<InsideInterface, 'id' | 'name'>): InsideInterface {
  return { kindWord: 'physical', unitCount: 0, units: [], ...overrides };
}

function zone(overrides: Partial<InsideZone> & Pick<InsideZone, 'id' | 'name'>): InsideZone {
  return { members: 0, ...overrides };
}

function policy(overrides: Partial<InsidePolicy> & Pick<InsidePolicy, 'id' | 'setId' | 'ordinal'>): InsidePolicy {
  return { name: '', action: 'permit', enabled: '1', description: '', ...overrides };
}

function policySet(overrides: Partial<InsidePolicySet> & Pick<InsidePolicySet, 'id'>): InsidePolicySet {
  return { scope: '', policyCount: 0, policies: [], ...overrides };
}

function route(overrides: Partial<InsideRoute> & Pick<InsideRoute, 'id' | 'name'>): InsideRoute {
  return { protocols: [], ...overrides };
}

function tunnel(overrides: Partial<InsideTunnel> & Pick<InsideTunnel, 'id' | 'name' | 'unit'>): InsideTunnel {
  return { ...overrides };
}

function faces(overrides: Partial<InsideFaces> = {}): InsideFaces {
  return {
    deviceId: 'device-1',
    hostname: 'srx-branch-01',
    interfaces: [],
    zones: [],
    policySets: [],
    routes: [],
    tunnels: [],
    unzoned: 0,
    ...overrides,
  };
}

function baseProps(overrides: Partial<InsideStopProps> = {}): InsideStopProps {
  return { chassis: chassis(), faces: faces(), litPortLabel: null, ...overrides };
}

function render(props: InsideStopProps): string {
  return renderToStaticMarkup(createElement(InsideStop, props));
}

describe('InsideStop (render-to-string)', () => {
  it('draws the jacks at the edge from chassis.ports, and lights the one litPortLabel names', () => {
    const markup = render(baseProps({ litPortLabel: 'ge-0/0/1' }));
    expect(markup).toContain('ge-0/0/0');
    expect(markup).toContain('ge-0/0/1');
    const lit = markup.match(/inside-stop__jack--lit[^]*?<\/div>/)?.[0] ?? '';
    expect(lit).toContain('ge-0/0/1');
  });

  it('draws a zone as a region with its member units inside it', () => {
    const f = faces({
      interfaces: [
        iface({
          id: 'if-1',
          name: 'ge-0/0/1',
          units: [unit({ id: 'u-1', interfaceId: 'if-1', label: 'ge-0/0/1.0', addresses: '10.0.0.1/24', zoneId: 'z-1', zoneName: 'trust' })],
        }),
      ],
      zones: [zone({ id: 'z-1', name: 'trust', members: 1 })],
    });
    const markup = render(baseProps({ faces: f }));
    expect(markup).toContain('trust');
    expect(markup).toContain('ge-0/0/1.0');
    expect(markup).toContain('10.0.0.1/24');
  });

  it('draws an empty zone as an empty region with only its name, never "none configured"', () => {
    const f = faces({ zones: [zone({ id: 'z-1', name: 'untrust', members: 0 })] });
    const markup = render(baseProps({ faces: f }));
    expect(markup).toContain('untrust');
    expect(markup.toLowerCase()).not.toContain('none configured');
    expect(markup.toLowerCase()).not.toContain('none');
  });

  it('reports a unit bound to no zone in the unzoned band, rather than leaving it blank', () => {
    const f = faces({
      interfaces: [
        iface({
          id: 'if-1',
          name: 'ge-0/0/1',
          units: [unit({ id: 'u-10', interfaceId: 'if-1', label: 'ge-0/0/1.10' })],
        }),
      ],
      unzoned: 1,
    });
    const markup = render(baseProps({ faces: f }));
    expect(markup).toContain('unzoned');
    expect(markup).toContain('ge-0/0/1.10');
  });

  it('draws the policy stack in the order the rows already arrive, with an ordinal rail, and never re-sorts', () => {
    const f = faces({
      policySets: [
        policySet({
          id: 'set-1',
          policyCount: 4,
          policies: [
            policy({ id: 'p-31', setId: 'set-1', ordinal: '31', name: 'reject-dns', action: 'reject' }),
            policy({ id: 'p-1', setId: 'set-1', ordinal: '1', name: 'allow-lan', action: 'permit' }),
            policy({ id: 'p-21', setId: 'set-1', ordinal: '21', name: 'disabled-plex', action: 'permit', enabled: '0' }),
            policy({ id: 'p-11', setId: 'set-1', ordinal: '11', name: 'block-rdp', action: 'block' }),
          ],
        }),
      ],
    });
    const markup = render(baseProps({ faces: f }));
    const order = ['reject-dns', 'allow-lan', 'disabled-plex', 'block-rdp'].map((n) => markup.indexOf(n));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(markup).toContain('disabled');
  });

  it('names the zones, the set, and the policies — never permitted, denied, allowed or blocked as Fathom\'s own words', () => {
    const f = faces({
      policySets: [
        policySet({
          id: 'set-1',
          policies: [policy({ id: 'p-1', setId: 'set-1', ordinal: '1', name: 'allow-lan', action: 'permit' })],
        }),
      ],
    });
    const markup = render(baseProps({ faces: f }));
    for (const word of ['permitted', 'denied', 'allowed', 'blocked']) {
      expect(markup.toLowerCase()).not.toContain(word);
    }
    expect(markup).toContain('permit'); // the stored action token itself
  });

  it('draws routes with their protocol adjacency counts, and tunnels naming the unit they bind', () => {
    const f = faces({
      routes: [
        route({
          id: 'r-1',
          name: 'inet.0',
          protocols: [{ id: 'proto-1', instanceId: 'r-1', protocol: 'ospf', adjacencies: 2 }],
        }),
      ],
      tunnels: [tunnel({ id: 't-1', name: 'hq-vpn', unit: 'st0.0' })],
    });
    const markup = render(baseProps({ faces: f }));
    expect(markup).toContain('inet.0');
    expect(markup).toContain('ospf');
    expect(markup).toContain('2 adjacencies');
    expect(markup).toContain('hq-vpn');
    expect(markup).toContain('st0.0');
  });

  it('renders with an entirely empty faces object — the panel still draws, nothing else does', () => {
    const markup = render(baseProps({ faces: faces() }));
    expect(markup).toContain('ge-0/0/0');
    expect(markup.toLowerCase()).not.toContain('none configured');
  });
});
