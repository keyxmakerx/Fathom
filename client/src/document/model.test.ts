import { describe, expect, it } from 'vitest';

import { familySet, interfaceAddress, interfaceName, ipAddr, ipPrefix, vlanId } from './model';

// These encoders must be byte-identical to `crates/fathom-ir/src/scalar.rs`'s
// `canonical()` for the same types. The IPv4 boundary cases below match
// `std::net::IpAddr::from_str`: a leading zero in an octet is refused, not
// four dotted octets is refused, and the canonical spelling never carries a
// leading zero.

describe('interfaceName', () => {
  it('accepts printable ASCII, matching Identifier', () => {
    expect(interfaceName('ge-0/0/0')).toBe('ge-0/0/0');
  });
  it('refuses empty', () => {
    expect(() => interfaceName('')).toThrow(RangeError);
  });
  it('refuses a space', () => {
    expect(() => interfaceName('ge 0')).toThrow(RangeError);
  });
});

describe('vlanId', () => {
  it('accepts the boundary values', () => {
    expect(vlanId(1)).toBe('1');
    expect(vlanId(4094)).toBe('4094');
  });
  it('refuses 0', () => {
    expect(() => vlanId(0)).toThrow(RangeError);
  });
  it('refuses 4095', () => {
    expect(() => vlanId(4095)).toThrow(RangeError);
  });
  it('refuses a non-integer', () => {
    expect(() => vlanId(1.5)).toThrow(RangeError);
  });
});

describe('ipAddr', () => {
  it('round-trips a canonical IPv4 address', () => {
    expect(ipAddr('10.0.0.1')).toBe('10.0.0.1');
    expect(ipAddr('255.255.255.255')).toBe('255.255.255.255');
  });
  it('refuses a leading zero in an octet', () => {
    expect(() => ipAddr('010.0.0.1')).toThrow(RangeError);
  });
  it('refuses an octet above 255', () => {
    expect(() => ipAddr('1.2.3.256')).toThrow(RangeError);
  });
  it('refuses fewer than four octets', () => {
    expect(() => ipAddr('1.2.3')).toThrow(RangeError);
  });
  it('refuses IPv6 -- IPv4 only (ADR-0058 decision 8)', () => {
    expect(() => ipAddr('::1')).toThrow(RangeError);
  });
});

describe('ipPrefix', () => {
  it('accepts a prefix with no host bits', () => {
    expect(ipPrefix('10.0.0.0/24')).toBe('10.0.0.0/24');
    expect(ipPrefix('0.0.0.0/0')).toBe('0.0.0.0/0');
    expect(ipPrefix('10.0.0.5/32')).toBe('10.0.0.5/32');
  });
  it('refuses host bits', () => {
    expect(() => ipPrefix('10.0.0.1/24')).toThrow(RangeError);
  });
  it('refuses a prefix length above 32', () => {
    expect(() => ipPrefix('10.0.0.0/33')).toThrow(RangeError);
  });
  it('refuses a leading zero in the prefix length', () => {
    expect(() => ipPrefix('10.0.0.0/08')).toThrow(RangeError);
    expect(() => ipPrefix('0.0.0.0/00')).toThrow(RangeError);
  });
  it('keeps a bare "/0" legal', () => {
    expect(ipPrefix('0.0.0.0/0')).toBe('0.0.0.0/0');
  });
});

describe('interfaceAddress', () => {
  it('keeps host bits, unlike ipPrefix', () => {
    expect(interfaceAddress('10.0.0.5/24')).toBe('10.0.0.5/24');
  });
  it('refuses a malformed shape', () => {
    expect(() => interfaceAddress('10.0.0.5')).toThrow(RangeError);
  });
  it('refuses a leading zero in the prefix length', () => {
    expect(() => interfaceAddress('10.0.0.1/08')).toThrow(RangeError);
  });
});

describe('familySet', () => {
  it('writes one member as a one-element array', () => {
    expect(familySet(['inet'])).toEqual(['inet']);
  });
  it('sorts by the enum declaration order, not input order', () => {
    expect(familySet(['inet6', 'inet'])).toEqual(['inet', 'inet6']);
  });
  it('dedupes', () => {
    expect(familySet(['inet', 'inet', 'inet6'])).toEqual(['inet', 'inet6']);
  });
  it('refuses an undeclared token', () => {
    expect(() => familySet(['mpls_over_ipv6', 'inet'])).toThrow(RangeError);
  });
  it('refuses an empty string', () => {
    expect(() => familySet([''])).toThrow(RangeError);
  });
});
