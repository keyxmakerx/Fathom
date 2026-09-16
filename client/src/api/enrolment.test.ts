// `buildRedeemAccountBody`'s expected bytes below were produced by an
// independent Python script (struct.pack('<I', len) + bytes, run by hand,
// not committed -- the equivalent of `gen_session_vectors.py`'s method,
// documented here since this one script is short enough not to warrant its
// own file):
//
//   import struct
//   def lp(b): return struct.pack('<I', len(b)) + b
//   token = bytes(range(32))
//   address = "jörg@example.com".encode('utf-8')
//   pubkey = bytes.fromhex('04462dba...dde1')  # SESSION_PUBKEY, session.test.ts
//   (lp(token) + lp(address) + lp(pubkey)).hex()
//
// This does not call `lp`, `concatBytes` or `utf8` from `../crypto/bytes` --
// the point, restated from `session.test.ts`, is that a test built from this
// module's own helpers and compared to itself would pass for any wrong
// construction too. `admin.rs`'s `read_fields(&body, 3)` reads three
// length-prefixed fields in this order and refuses a fourth
// (`read_fields`'s own doc comment) -- exactly what is asserted below: the
// body's total length equals the sum of the three framed fields, with
// nothing left over.
import { describe, expect, it, vi } from 'vitest';

import { fromHex, toHex } from '../crypto/bytes';
import { ApiRefusal } from './errors';
import {
  buildRedeemAccountBody,
  MalformedTokenError,
  parseRedeemAccountResponse,
  parseToken,
  redeemAccountEnrolment,
} from './enrolment';

const TOKEN = fromHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const ADDRESS = 'jörg@example.com'; // non-ASCII: ö is 0xC3 0xB6 in UTF-8
const PUBLIC_KEY = fromHex(
  '04462dba1ae4fc1a968b4dacf20cdd6dbe1fae34aa971514a63d3405c3d1cfd383b58bbb08c1' +
    '3383428c5853c71c4c851e134b056821e468fe0a977abf4313dde1',
);

const EXPECTED_BODY_HEX =
  '20000000000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f11' +
  '0000006ac3b67267406578616d706c652e636f6d4100000004462dba1ae4fc1a968b4dacf2' +
  '0cdd6dbe1fae34aa971514a63d3405c3d1cfd383b58bbb08c13383428c5853c71c4c851e13' +
  '4b056821e468fe0a977abf4313dde1';

describe('buildRedeemAccountBody (crates/fathom-server/src/admin.rs redeem_account)', () => {
  it('matches the independently-computed vector, byte for byte, with a non-ASCII address', () => {
    const body = buildRedeemAccountBody(TOKEN, ADDRESS, PUBLIC_KEY);
    expect(toHex(body)).toBe(EXPECTED_BODY_HEX);
  });

  it('carries exactly three length-prefixed fields and nothing after the third', () => {
    // read_fields(&body, 3) in admin.rs: read exactly 3 LP fields, then
    // require the remainder to be empty.
    const body = buildRedeemAccountBody(TOKEN, ADDRESS, PUBLIC_KEY);
    let rest = body;
    for (let i = 0; i < 3; i += 1) {
      const len = new DataView(rest.buffer, rest.byteOffset, 4).getUint32(0, true);
      rest = rest.slice(4 + len);
    }
    expect(rest.length).toBe(0);
  });
});

describe('parseRedeemAccountResponse (admin.rs redeem_account\'s answer)', () => {
  it('reads the single LP(key_id) field the server sends back', () => {
    // crypto::lp(&mut out, key.as_bytes()) over the String operators.rs
    // returns -- one field, UTF-8.
    const keyId = '01JXENROLKEYIDEXAMPLE0000A';
    const encoded = new TextEncoder().encode(keyId);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, encoded.length, true);
    const response = new Uint8Array(len.length + encoded.length);
    response.set(len, 0);
    response.set(encoded, len.length);
    expect(parseRedeemAccountResponse(response)).toBe(keyId);
  });
});

describe('parseToken (this screen\'s own local format check, not a server refusal)', () => {
  it('accepts a 64-character lowercase hex token', () => {
    const hex = '00'.repeat(32);
    expect(toHex(parseToken(hex))).toBe(hex);
  });

  it('accepts surrounding whitespace and mixed case', () => {
    const hex = 'AB'.repeat(32);
    expect(toHex(parseToken(`  ${hex}  `))).toBe(hex.toLowerCase());
  });

  it('rejects anything that is not exactly 32 bytes of hex', () => {
    expect(() => parseToken('not-a-token')).toThrow(MalformedTokenError);
    expect(() => parseToken('ab'.repeat(31))).toThrow(MalformedTokenError);
    expect(() => parseToken('ab'.repeat(33))).toThrow(MalformedTokenError);
    expect(() => parseToken('')).toThrow(MalformedTokenError);
  });
});

describe('redeemAccountEnrolment refusals: one message for every cause', () => {
  // operators.rs: OperatorError::EnrolmentRefused is "deliberately one
  // variant for several causes" (a token never issued, one already
  // redeemed, one past expiry, one presented with the wrong address). All
  // four render, in admin.rs's AdminRefusal, as SessionError::SignInRefused
  // -> 401 "sign-in refused\n". This client must not add a distinction the
  // server refused to make, so two different underlying causes -- modelled
  // here only by two separate fetch calls, since this client cannot tell
  // them apart either -- must produce the exact same message.
  it('surfaces the server\'s one refusal sentence unchanged, for two different underlying causes alike', async () => {
    const causes = ['unknown or already-redeemed token', 'wrong address for this token'];
    const messages: string[] = [];

    for (const _cause of causes) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response('sign-in refused\n', {
            status: 401,
            headers: { 'content-type': 'text/plain' },
          }),
        ),
      );
      try {
        await redeemAccountEnrolment(TOKEN, ADDRESS);
        throw new Error('expected redeemAccountEnrolment to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiRefusal);
        messages.push((error as ApiRefusal).message);
      } finally {
        vi.unstubAllGlobals();
      }
    }

    expect(messages[0]).toBe('sign-in refused');
    expect(messages[0]).toBe(messages[1]);
  });

  it('surfaces a malformed-request refusal as the server\'s own distinct sentence, not this client\'s guess', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('malformed request\n', { status: 400 })),
    );
    try {
      await redeemAccountEnrolment(TOKEN, ADDRESS);
      throw new Error('expected redeemAccountEnrolment to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiRefusal);
      expect((error as ApiRefusal).message).toBe('malformed request');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
