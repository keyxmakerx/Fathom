import { describe, expect, it } from 'vitest';

import type { ChassisView, PortView } from './contract';
import { isPowerConnector, pduUsage, pduUsageLabel } from './power';

function port(overrides: Partial<PortView> & Pick<PortView, 'id'>): PortView {
  return { label: '', connector: 'c13', row: 0, column: 0, uplink: false, cable: null, ...overrides };
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
