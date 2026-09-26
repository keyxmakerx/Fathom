// The bytes `crates/fathom-server/src/placement.rs` writes and reads, and
// the two answers `admin.rs`'s stream (b) block gives.
//
// Every vector below was produced by a Python one-liner from the server's
// own doc comments -- `struct.pack('<I', len) + bytes` for each LP field and
// `struct.pack('<Q', n)` for each u64 -- and never by this module's own
// encoder, which is the method `api/console.test.ts` and
// `api/enrolment.test.ts` already document. A test that asked the encoder
// what the encoder produces would pass while the wire was wrong.

import { describe, expect, it } from 'vitest';

import { fromHex, toHex } from '../crypto/bytes';
import {
  buildOperatorSignInBody,
  buildPlacementBody,
  consoleUrlForHost,
  EVERYWHERE_SOURCES,
  normalisePlacementHosts,
  normalisePlacementSources,
  parseFlagAnswer,
  parseOperatorKeyAnswer,
  parsePlacementAnswer,
  placementRequestBytes,
} from './placement';

describe('parseFlagAnswer (placement.rs flag)', () => {
  it('reads "yes" and the deadline of a placement waiting to be confirmed', () => {
    // lp("yes") + lp("1790000000")
    expect(parseFlagAnswer(fromHex('030000007965730a00000031373930303030303030'))).toEqual({
      consoleHost: true,
      confirmByUnix: 1_790_000_000,
      decidedBy: null,
    });
  });

  it('reads "yes" with an empty deadline as nothing pending', () => {
    // lp("yes") + lp("") -- a confirmed placement, an open console, or the
    // environment deciding: `AdminExposure::confirm_by` gives none for all
    // three, and this client does not invent a difference.
    expect(parseFlagAnswer(fromHex('0300000079657300000000'))).toEqual({
      consoleHost: true,
      confirmByUnix: null,
      decidedBy: null,
    });
  });

  it('reads "no" as one field with nothing after it', () => {
    expect(parseFlagAnswer(fromHex('020000006e6f'))).toEqual({
      consoleHost: false,
      confirmByUnix: null,
      decidedBy: null,
    });
  });

  it('refuses a trailing byte and a verdict that is neither word', () => {
    expect(() => parseFlagAnswer(fromHex('020000006e6fff'))).toThrow(/trailing/);
    expect(() => parseFlagAnswer(fromHex('030000007965'))).toThrow(/truncated/);
    // lp("maybe")
    expect(() => parseFlagAnswer(fromHex('050000006d61796265'))).toThrow(/malformed placement flag/);
  });
});

// The third field, which the server binary this was built against does not
// send. Every vector below is `struct.pack('<I', len) + bytes` per field,
// written out by hand from the shape the route will answer with, the same
// method as the vectors above.
describe('parseFlagAnswer: the OPTIONAL third field, which says which decided', () => {
  it('absent is null, and null is not a verdict: today’s server says nothing', () => {
    // lp("yes") + lp("") -- the whole of what the route sends today.
    expect(parseFlagAnswer(fromHex('0300000079657300000000')).decidedBy).toBeNull();
    // lp("no")
    expect(parseFlagAnswer(fromHex('020000006e6f')).decidedBy).toBeNull();
  });

  it('reads "environment" after the deadline field', () => {
    // lp("yes") + lp("") + lp("environment")
    expect(
      parseFlagAnswer(fromHex('03000000796573000000000b000000656e7669726f6e6d656e74')),
    ).toEqual({ consoleHost: true, confirmByUnix: null, decidedBy: 'environment' });
  });

  it('reads "console" beside a deadline that is still running', () => {
    // lp("yes") + lp("1790000000") + lp("console")
    expect(
      parseFlagAnswer(
        fromHex('030000007965730a0000003137393030303030303007000000636f6e736f6c65'),
      ),
    ).toEqual({ consoleHost: true, confirmByUnix: 1_790_000_000, decidedBy: 'console' });
  });

  it('reads "open" -- a console that answers everywhere', () => {
    // lp("yes") + lp("") + lp("open")
    expect(
      parseFlagAnswer(fromHex('0300000079657300000000040000006f70656e')).decidedBy,
    ).toBe('open');
  });

  it('reads a decider after "no" too, where the answer matters most', () => {
    // lp("no") + lp("environment")
    expect(parseFlagAnswer(fromHex('020000006e6f0b000000656e7669726f6e6d656e74'))).toEqual({
      consoleHost: false,
      confirmByUnix: null,
      decidedBy: 'environment',
    });
  });

  it('refuses a word it was not told to expect rather than passing it on', () => {
    // lp("yes") + lp("") + lp("proxy")
    expect(() =>
      parseFlagAnswer(fromHex('03000000796573000000000500000070726f7879')),
    ).toThrow(/malformed placement flag decider/);
  });

  it('refuses bytes that are not a field, with the message it always gave', () => {
    // lp("yes") + lp("") + one stray byte
    expect(() => parseFlagAnswer(fromHex('0300000079657300000000ff'))).toThrow(/trailing/);
    // lp("yes") + lp("") + lp("open") + one stray byte
    expect(() =>
      parseFlagAnswer(fromHex('0300000079657300000000040000006f70656eff')),
    ).toThrow(/trailing/);
  });
});

describe('placementRequestBytes (placement.rs placement_request_bytes)', () => {
  it('is LP(tag) || LP(deployment) || LP(operator) || LP(hosts) || LP(sources) || u64(window)', () => {
    const bytes = placementRequestBytes(
      '01JXDEPLOY',
      '01JXOP1',
      'console.example.net',
      '10.0.0.0/8',
      300,
    );
    expect(toHex(bytes)).toBe(
      '20000000666174686f6d2f736974652f706c6163656d656e742f726571756573742f7631' +
        '0a00000030314a584445504c4f59' +
        '0700000030314a584f5031' +
        '13000000636f6e736f6c652e6578616d706c652e6e6574' +
        '0a00000031302e302e302e302f38' +
        '2c01000000000000',
    );
  });

  it('puts the window inside the signature, little-endian, as the server does', () => {
    const three = placementRequestBytes('d', 'o', 'h', 's', 300);
    const sixty = placementRequestBytes('d', 'o', 'h', 's', 60);
    expect(toHex(three).endsWith('2c01000000000000')).toBe(true);
    expect(toHex(sixty).endsWith('3c00000000000000')).toBe(true);
  });
});

describe('buildPlacementBody (placement.rs request_placement, four fields)', () => {
  it('is LP(hosts) || LP(sources) || LP(window as text) || LP(assertion)', () => {
    const body = buildPlacementBody(
      'console.example.net',
      EVERYWHERE_SOURCES,
      60,
      new Uint8Array([1, 2, 3]),
    );
    expect(toHex(body)).toBe(
      '13000000636f6e736f6c652e6578616d706c652e6e6574' +
        '0e000000302e302e302e302f302c3a3a2f30' +
        '020000003630' +
        '03000000010203',
    );
  });
});

describe('parsePlacementAnswer', () => {
  it('reads LP(id) || u64(confirm_by)', () => {
    expect(
      parsePlacementAnswer(
        fromHex('1a00000030314a58504c4143454d454e5430303030303030303030303031ac3cb16a00000000'),
      ),
    ).toEqual({ id: '01JXPLACEMENT0000000000001', confirmByUnix: 1_790_000_300 });
  });

  it('refuses an answer with anything but eight bytes after the id', () => {
    expect(() =>
      parsePlacementAnswer(fromHex('1a00000030314a58504c4143454d454e5430303030303030303030303031ac3cb16a000000')),
    ).toThrow(/7 byte\(s\) where u64/);
  });
});

describe('the operator custody an account picks up', () => {
  it('reads LP(key_id) || LP(operator_id) and refuses a trailing byte', () => {
    const hex =
      '1800000030314a584b45593030303030303030303030303030303031' +
      '1900000030314a584f5032303030303030303030303030303030303032';
    expect(parseOperatorKeyAnswer(fromHex(hex))).toEqual({
      keyId: '01JXKEY00000000000000001',
      operatorId: '01JXOP2000000000000000002',
    });
    expect(() => parseOperatorKeyAnswer(fromHex(`${hex}ff`))).toThrow(/trailing/);
  });

  it("signs the operator in with nine fields, the last four empty: the operator plane carries no password, a fresh account session needs no code, and this tab holds no grace token", () => {
    const body = buildOperatorSignInBody(
      new Uint8Array([4, 5, 6]),
      new Uint8Array([7, 8]),
      new Uint8Array([9]),
      '',
      '',
      new Uint8Array(0),
    );
    expect(toHex(body)).toBe(
      '080000006f70657261746f72' + // LP("operator")
        '03000000040506' + //          LP(session public key)
        '020000000708' + //            LP(nonce)
        '0100000009' + //              LP(evidence signature)
        '00000000' + //                LP("") -- no password
        '00000000' + //                LP("") -- no verification code
        '00000000' + //                LP("") -- no account session id
        '00000000' + //                LP("") -- no account session signature
        '00000000', //                 LP("") -- no grace token
    );
  });

  it('carries a verification code and the account-session endorsement when both are given', () => {
    const body = buildOperatorSignInBody(
      new Uint8Array([4]),
      new Uint8Array([7]),
      new Uint8Array([9]),
      '123456',
      '01JXACCT0000000000000001',
      new Uint8Array([1, 2]),
    );
    expect(toHex(body)).toBe(
      '080000006f70657261746f72' + // LP("operator")
        '0100000004' + //              LP(session public key)
        '0100000007' + //              LP(nonce)
        '0100000009' + //              LP(evidence signature)
        '00000000' + //                LP("") -- no password
        '06000000313233343536' + //    LP("123456")
        '1800000030314a584143435430303030303030303030303030303031' + // LP(account session id)
        '020000000102' + //            LP(account session signature)
        '00000000', //                 LP("") -- no grace token
    );
  });

  it('carries the grace token when this tab holds one for the endorsing session', () => {
    const body = buildOperatorSignInBody(
      new Uint8Array([4]),
      new Uint8Array([7]),
      new Uint8Array([9]),
      '',
      '01JXACCT0000000000000001',
      new Uint8Array([1, 2]),
      new Uint8Array([0xaa, 0xbb]),
    );
    expect(toHex(body).endsWith('02000000aabb')).toBe(true);
  });
});

describe('what the operator typed, as the server will store it', () => {
  it('trims the hosts and leaves them otherwise alone: the signature covers that text', () => {
    expect(normalisePlacementHosts('  console.example.net , b.example.net ')).toBe(
      'console.example.net , b.example.net',
    );
  });

  it('spells "from anywhere" the way sources_text does, because the column cannot be blank', () => {
    expect(normalisePlacementSources('')).toBe('0.0.0.0/0,::/0');
    expect(normalisePlacementSources('   ')).toBe('0.0.0.0/0,::/0');
    expect(normalisePlacementSources(' 10.0.0.0/8 ')).toBe('10.0.0.0/8');
  });
});

describe('consoleUrlForHost (the redirect decision 11 asks for)', () => {
  const from = { protocol: 'https:', port: '', pathname: '/' };

  it('takes the first host of the placement and keeps this page\'s scheme, port and path', () => {
    expect(consoleUrlForHost('console.example.net', from)).toBe('https://console.example.net/');
    expect(consoleUrlForHost('a.example.net, b.example.net', from)).toBe('https://a.example.net/');
    expect(
      consoleUrlForHost('localhost', { protocol: 'http:', port: '18102', pathname: '/' }),
    ).toBe('http://localhost:18102/');
  });

  it('does not force https on a page that is not on it', () => {
    // A console served over plain HTTP that sent its operator to https://
    // would send them to a port nothing listens on -- the lockout the
    // interlock exists to survive.
    expect(consoleUrlForHost('console.example.net', { protocol: 'http:', port: '8080', pathname: '/' })).toBe(
      'http://console.example.net:8080/',
    );
  });

  it('refuses a placement with no host', () => {
    expect(() => consoleUrlForHost('  ', from)).toThrow(/no host/);
  });
});
