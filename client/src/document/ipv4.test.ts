// One IPv4 rule across the browser: model.ts's reader, which matches Rust's
// std::net::Ipv4Addr (checked with rustc 1.97: "01.0.0.1" and "10.00.0.1" are
// refused, "10.0.0.1" and "0.0.0.0" accepted).
import { describe, expect, it } from 'vitest';

import { isIpAddr } from './edit';
import { parseIpv4 } from './ipam';
import { isCanonicalIpv4, ipv4Number } from './model';
import { addressFor } from '../import/plan';

const REFUSED = ['01.0.0.1', '10.00.0.1', '010.0.0.1', '256.0.0.1', '10.0.0', '10.0.0.1.1', '10.0.0.-1', ' 10.0.0.1x', ''];
const ACCEPTED = ['10.0.0.1', '0.0.0.0', '255.255.255.255', '192.168.10.0'];

describe('one IPv4 reader', () => {
  it('refuses leading zeros and malformed addresses everywhere', () => {
    for (const s of REFUSED) {
      expect(isCanonicalIpv4(s), s).toBe(false);
      expect(isIpAddr(s), `management address ${s}`).toBe(false);
      expect(parseIpv4(s), `ipam ${s}`).toBeUndefined();
      expect(addressFor(s), `import ${s}`).toBeNull();
    }
  });

  it('accepts canonical addresses everywhere, with the same number', () => {
    for (const s of ACCEPTED) {
      expect(isCanonicalIpv4(s), s).toBe(true);
      expect(isIpAddr(s), s).toBe(true);
      expect(parseIpv4(s)).toBe(ipv4Number(s));
    }
    expect(ipv4Number('10.0.0.1')).toBe(167772161);
    expect(ipv4Number('255.255.255.255')).toBe(4294967295);
  });

  it('still takes IPv6 for a management address', () => {
    expect(isIpAddr('2001:db8::1')).toBe(true);
  });
});
