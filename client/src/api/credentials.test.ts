// The credential plane's bytes, checked against a second, independent
// encoder. `enrolment.test.ts`'s header names the reason this file repeats
// those four helpers instead of importing `../crypto/bytes`: a test that
// assembled its expectation with the module's own `lp` and then compared it
// against that same `lp` would pass for any framing whatsoever, including a
// wrong one. The numbers below are written out by hand from
// `crates/fathom-server/src/api.rs`'s `credential_router` block and
// `placement.rs`'s `flag`.
import { describe, expect, it } from 'vitest';

import {
  appCodeEnrolmentRequired,
  buildAddressBody,
  buildAppCodeBody,
  buildPasswordBody,
  buildPublicKeyBody,
  buildTokenAndPasswordBody,
  isTotpRequired,
  looksLikeAppCode,
  parseBackupCodes,
  parseKeyId,
  parseTotpEnrolment,
} from './credentials';
import { ApiRefusal } from './errors';

function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function lpField(text: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(text));
  return [...u32le(bytes.length), ...bytes];
}

function lpBytes(bytes: number[]): number[] {
  return [...u32le(bytes.length), ...bytes];
}

describe('the credential request bodies (api.rs credential_router)', () => {
  it('frames LP(token) || LP(password) for the setup and reset-redeem routes', () => {
    const token = Array.from({ length: 32 }, (_, i) => (i * 7) % 256);
    const password = 'harbour-lantern-copper-nine';

    expect(Array.from(buildTokenAndPasswordBody(Uint8Array.from(token), password))).toEqual([
      ...lpBytes(token),
      ...lpField(password),
    ]);
  });

  it('frames LP(password) alone for POST /credentials/password', () => {
    expect(Array.from(buildPasswordBody('a-password-of-real-length'))).toEqual([
      ...lpField('a-password-of-real-length'),
    ]);
  });

  it('frames LP(app_code), trimmed of the whitespace a paste carries', () => {
    expect(Array.from(buildAppCodeBody('  123456 '))).toEqual([...lpField('123456')]);
  });

  it('leaves a backup code exactly as typed apart from the outer trim', () => {
    // The hyphens and the case are the SERVER's to fold
    // (`credentials::normalise_code`), and a client that folded them too
    // would be a second implementation of the rule the stored hash depends
    // on.
    expect(Array.from(buildAppCodeBody(' 9hy4-k2mn-0p3q-7rst '))).toEqual([...lpField('9hy4-k2mn-0p3q-7rst')]);
  });

  it('frames LP(public_key) for a 65-byte SEC1 point', () => {
    const key = [0x04, ...Array.from({ length: 64 }, (_, i) => i)];
    expect(Array.from(buildPublicKeyBody(Uint8Array.from(key)))).toEqual([...lpBytes(key)]);
    // The length prefix is the SEC1 length and not a fixed 65 written twice.
    expect(Array.from(buildPublicKeyBody(Uint8Array.from(key))).slice(0, 4)).toEqual([65, 0, 0, 0]);
  });

  it('frames LP(address) for the forgot-password route', () => {
    expect(Array.from(buildAddressBody('owner@example.test'))).toEqual([...lpField('owner@example.test')]);
  });

  it('puts a non-ASCII password on the wire as UTF-8, length in bytes and not characters', () => {
    // `text()` on the server is `String::from_utf8`, so the length prefix
    // counts bytes. A client that counted characters would frame a body the
    // server reads as truncated.
    const body = Array.from(buildPasswordBody('pässwörd-långt-nog-för-det'));
    const expected = Array.from(new TextEncoder().encode('pässwörd-långt-nog-för-det'));
    expect(body.slice(0, 4)).toEqual(u32le(expected.length));
    expect(body.length).toBe(4 + expected.length);
  });
});

describe('the credential answers', () => {
  it('reads LP(otpauth_uri) || LP(secret_base32)', () => {
    const uri = 'otpauth://totp/Fathom:owner@example.test?secret=JBSWY3DPEHPK3PXP&issuer=Fathom&algorithm=SHA1&digits=6&period=30';
    const secret = 'JBSWY3DPEHPK3PXP';
    const enrolment = parseTotpEnrolment(Uint8Array.from([...lpField(uri), ...lpField(secret)]));
    expect(enrolment.otpauthUri).toBe(uri);
    expect(enrolment.secretBase32).toBe(secret);
  });

  it('refuses trailing bytes after the secret rather than ignoring them', () => {
    const bytes = Uint8Array.from([...lpField('otpauth://totp/x'), ...lpField('AAAA'), 0xde, 0xad]);
    expect(() => parseTotpEnrolment(bytes)).toThrow();
  });

  it('reads every LP(backup_code) the answer carries, in order', () => {
    const codes = Array.from({ length: 10 }, (_, i) => `${i}aaa-bbbb-cccc-dddd`);
    const bytes = Uint8Array.from(codes.flatMap((code) => lpField(code)));
    expect(parseBackupCodes(bytes)).toEqual(codes);
  });

  it('does not insist on ten: the server says how many it minted', () => {
    expect(parseBackupCodes(Uint8Array.from(lpField('only-one')))).toEqual(['only-one']);
    expect(parseBackupCodes(new Uint8Array(0))).toEqual([]);
  });

  it('reads LP(key_id) and refuses anything after it', () => {
    expect(parseKeyId(Uint8Array.from(lpField('01JXKEY0000000000000000001')))).toBe('01JXKEY0000000000000000001');
    expect(() => parseKeyId(Uint8Array.from([...lpField('k'), 0x00]))).toThrow();
  });

});

describe('the setup-gate refusal, which is a route and not a wall', () => {
  it('matches the 403 and the sentence api.rs fixes for SessionError::TotpRequired', () => {
    expect(isTotpRequired(new ApiRefusal(403, 'set up an authenticator first', null))).toBe(true);
  });

  it('still matches the sentence a server from before 2026-09-22 sends', () => {
    // ADR-0056 decision 4 moved this sentence, and a deployment restarts its
    // halves one at a time: for the length of one restart this client can be
    // talking to a server from the last build, and the refusal is the only
    // thing that routes a person to the enrolment screen.
    expect(isTotpRequired(new ApiRefusal(403, 'enrol an app code first', null))).toBe(true);
  });

  it('does not match the other 403, which means the opposite', () => {
    expect(isTotpRequired(new ApiRefusal(403, 'not authorised', null))).toBe(false);
  });

  it('does not match a 401, and does not match a thrown non-refusal', () => {
    expect(isTotpRequired(new ApiRefusal(401, 'sign-in refused', null))).toBe(false);
    expect(isTotpRequired(new Error('enrol an app code first'))).toBe(false);
  });

  it('reads the probe through the same rule: 403-with-that-sentence and nothing else', async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response('set up an authenticator first\n', { status: 403 })) as typeof globalThis.fetch;
      // No session is set, so `signedFetch` throws before it reaches the
      // network -- which is not the refusal, and must read as "no".
      expect(await appCodeEnrolmentRequired()).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('what the sign-in code field holds', () => {
  it('calls six digits an app code and everything else not', () => {
    expect(looksLikeAppCode('123456')).toBe(true);
    expect(looksLikeAppCode('  123456  ')).toBe(true);
    expect(looksLikeAppCode('12345')).toBe(false);
    expect(looksLikeAppCode('9hy4-k2mn-0p3q-7rst')).toBe(false);
  });
});
