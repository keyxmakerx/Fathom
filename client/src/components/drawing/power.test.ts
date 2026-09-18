import { describe, expect, it } from 'vitest';

import type { ChassisView, InletView, PortView } from './contract';
import { isOneFitted, isPowerConnector, isSingleFed, pduUsage, pduUsageLabel } from './power';

function port(overrides: Partial<PortView> & Pick<PortView, 'id'>): PortView {
  return {
    label: '',
    connector: 'c13',
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

function pdu(ports: PortView[]): Pick<ChassisView, 'ports'> {
  return { ports };
}

describe('pduUsage', () => {
  it('counts fed outlets against the total — "8 of 8 used"', () => {
    const ports = Array.from({ length: 8 }, (_, i) =>
      port({ id: `o${i}`, cable: { cableId: `c${i}`, farPortId: 'far', farChassisId: 'far-c', outsideCloset: false } }),
    );
    expect(pduUsage(pdu(ports))).toEqual({ used: 8, total: 8 });
  });

  it('a partly-fed PDU counts only the fed outlets', () => {
    const ports = [
      port({ id: 'o0', cable: { cableId: 'c0', farPortId: 'far', farChassisId: 'far-c', outsideCloset: false } }),
      port({ id: 'o1', cable: null }),
      port({ id: 'o2', cable: null }),
    ];
    expect(pduUsage(pdu(ports))).toEqual({ used: 1, total: 3 });
  });

  it('the connector match is case-insensitive, matching the catalogue\'s raw token', () => {
    expect(pduUsage(pdu([port({ id: 'o0', connector: 'C13' })]))).toEqual({ used: 0, total: 1 });
  });

  it('a chassis with no c13 outlets is not read as a PDU', () => {
    expect(pduUsage(pdu([port({ id: 'p0', connector: 'rj45' })]))).toBeUndefined();
  });

  it('a chassis with no ports at all is not read as a PDU', () => {
    expect(pduUsage(pdu([]))).toBeUndefined();
  });

  it('counts nema515r outlets exactly as it counts c13 — schema 0.8, ADR-0051 §1', () => {
    const ports = [
      port({ id: 'o0', connector: 'nema515r', cable: { cableId: 'c0', farPortId: 'far', farChassisId: 'far-c', outsideCloset: false } }),
      port({ id: 'o1', connector: 'nema515r' }),
    ];
    expect(pduUsage(pdu(ports))).toEqual({ used: 1, total: 2 });
  });

  it('nema515p (the plug, not the receptacle) does not count as an outlet', () => {
    expect(pduUsage(pdu([port({ id: 'p0', connector: 'nema515p' })]))).toBeUndefined();
  });

  it('a tower UPS mixing c13 and nema515r outlets counts both kinds together', () => {
    const ports = [
      port({ id: 'o0', connector: 'c13', cable: { cableId: 'c0', farPortId: 'far', farChassisId: 'far-c', outsideCloset: false } }),
      port({ id: 'o1', connector: 'nema515r' }),
    ];
    expect(pduUsage(pdu(ports))).toEqual({ used: 1, total: 2 });
  });
});

describe('pduUsageLabel', () => {
  it('reads "n of m used"', () => {
    expect(pduUsageLabel({ used: 8, total: 8 })).toBe('8 of 8 used');
    expect(pduUsageLabel({ used: 0, total: 12 })).toBe('0 of 12 used');
  });
});

describe('isPowerConnector', () => {
  it('c14 and c13 both read as the power connector', () => {
    expect(isPowerConnector('c14')).toBe(true);
    expect(isPowerConnector('c13')).toBe(true);
    expect(isPowerConnector('C13')).toBe(true);
  });

  it('a data connector does not', () => {
    expect(isPowerConnector('rj45')).toBe(false);
  });
});

function inlet(overrides: Partial<InletView> & Pick<InletView, 'id'>): InletView {
  return {
    label: '',
    connector: 'c14',
    row: 0,
    column: 0,
    uplink: false,
    role: null,
    face: 'front',
    passThroughId: null,
    cable: null,
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

describe('isSingleFed — ADR-0050 §4, mirrored for a FixtureView', () => {
  it('two fitted inlets, one fed: single-fed', () => {
    const inlets = [
      inlet({ id: 'a', cable: { cableId: 'c0', farPortId: 'far', farChassisId: 'far-c', outsideCloset: false } }),
      inlet({ id: 'b', cable: null }),
    ];
    expect(isSingleFed(inlets)).toBe(true);
  });

  it('a single inlet, fed, is simply fed — not single-fed', () => {
    expect(isSingleFed([inlet({ id: 'a', cable: { cableId: 'c0', farPortId: 'far', farChassisId: 'far-c', outsideCloset: false } })])).toBe(
      false,
    );
  });

  it('two inlets both fed is not single-fed', () => {
    const fed = { cableId: 'c0', farPortId: 'far', farChassisId: 'far-c', outsideCloset: false };
    expect(isSingleFed([inlet({ id: 'a', cable: fed }), inlet({ id: 'b', cable: fed })])).toBe(false);
  });

  it('two inlets neither fed is not single-fed', () => {
    expect(isSingleFed([inlet({ id: 'a', cable: null }), inlet({ id: 'b', cable: null })])).toBe(false);
  });
});

describe('isOneFitted — ADR-0050 §4, mirrored for a FixtureView', () => {
  it('two slots, one unfitted: one-fitted', () => {
    expect(isOneFitted([inlet({ id: 'a', fitted: true }), inlet({ id: 'b', fitted: false })])).toBe(true);
  });

  it('a single slot is never one-fitted — nothing to be short of', () => {
    expect(isOneFitted([inlet({ id: 'a', fitted: false })])).toBe(false);
  });

  it('two slots, both fitted, is not one-fitted', () => {
    expect(isOneFitted([inlet({ id: 'a', fitted: true }), inlet({ id: 'b', fitted: true })])).toBe(false);
  });
});
