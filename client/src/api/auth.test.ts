// `parseSignInAnswer`'s bytes below are built by hand, not with `lp`/`u64LE`
// from `../crypto/bytes` -- `enrolment.test.ts`'s own header names the
// reason this repeats: a test assembled from a module's own encoder and then
// checked against that same encoder's decoder would pass for any
// construction whatsoever, including a wrong one.
import { describe, expect, it } from 'vitest';

import {
  buildSignInBody,
  completeSignIn,
  isSecondFactorNeeded,
  parseSignInAnswer,
  type SignInChallenge,
} from './auth';
import { ApiRefusal } from './errors';
import { exportPublicKeyRaw, generateKeyPair } from '../crypto/keys';
import { setSession } from '../state/sessionState';

function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function lpField(text: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(text));
  return [...u32le(bytes.length), ...bytes];
}

function u64le(n: number): number[] {
  const out = new Array(8).fill(0);
  let value = BigInt(n);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

describe('parseSignInAnswer (crates/fathom-server/src/api.rs sign_in_handler)', () => {
  it('reads LP(session_id) || LP(token) || u64(expires_at_unix) || LP(account_id), in that order', () => {
    const sessionId = '01JXSESSIONIDEXAMPLE00000A';
    const token = Array.from({ length: 32 }, (_, i) => i);
    const expiresAtUnix = 1_790_000_000;
    const accountId = '01JXACCOUNTIDEXAMPLE000001';

    const bytes = new Uint8Array([
      ...lpField(sessionId),
      ...u32le(token.length),
      ...token,
      ...u64le(expiresAtUnix),
      ...lpField(accountId),
    ]);

    const answer = parseSignInAnswer(bytes);
    expect(answer.sessionId).toBe(sessionId);
    expect(Array.from(answer.token)).toEqual(token);
    expect(answer.expiresAtUnix).toBe(expiresAtUnix);
    expect(answer.accountId).toBe(accountId);
  });

  it('ignores bytes after the fourth field -- additive per ADR-0053 §3, never refused as trailing', () => {
    const sessionId = 's';
    const token = new Array(32).fill(7);
    const accountId = '01JXACCOUNTIDEXAMPLE000002';

    const bytes = new Uint8Array([
      ...lpField(sessionId),
      ...u32le(token.length),
      ...token,
      ...u64le(1),
      ...lpField(accountId),
      0xde,
      0xad,
      0xbe,
      0xef,
    ]);

    expect(parseSignInAnswer(bytes).accountId).toBe(accountId);
  });

  it('throws on a truncated account id field rather than returning a partial answer', () => {
    const sessionId = 's';
    const token = new Array(32).fill(0);
    const bytes = new Uint8Array([
      ...lpField(sessionId),
      ...u32le(token.length),
      ...token,
      ...u64le(0),
      // A length prefix claiming 26 bytes with none following.
      ...u32le(26),
    ]);

    expect(() => parseSignInAnswer(bytes)).toThrow();
  });
});

// ADR-0055 client (a): the body `POST /session` reads with
// `read_fields(&body, 6)`. Built here from the same hand-rolled `u32le` the
// tests above use, so the expectation does not come from the encoder under
// test.
describe('buildSignInBody (api.rs sign_in_handler, six fields since ADR-0055 decision 10)', () => {
  const pubkey = Uint8Array.from([0x04, ...Array.from({ length: 64 }, (_, i) => i)]);
  const nonce = Uint8Array.from(Array.from({ length: 32 }, (_, i) => 255 - i));

  function lpOf(bytes: Uint8Array | number[]): number[] {
    const list = Array.from(bytes);
    return [...u32le(list.length), ...list];
  }

  it('writes kind, session pubkey, nonce, evidence, password and verification code in that order', () => {
    const evidence = Uint8Array.from(Array.from({ length: 64 }, () => 9));
    const body = buildSignInBody('steward', pubkey, nonce, evidence, 'harbour-lantern-copper-nine', '123456');

    expect(Array.from(body)).toEqual([
      ...lpField('steward'),
      ...lpOf(pubkey),
      ...lpOf(nonce),
      ...lpOf(evidence),
      ...lpField('harbour-lantern-copper-nine'),
      ...lpField('123456'),
    ]);
  });

  it('sends the two new fields empty on the key-only path rather than omitting them', () => {
    // `read_fields` refuses an inexact count, so a four-field body is a 400
    // and not a shorter version of the same request.
    const evidence = Uint8Array.from(Array.from({ length: 64 }, () => 1));
    const body = buildSignInBody('operator', pubkey, nonce, evidence, '', '');
    const tail = Array.from(body).slice(-8);
    expect(tail).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(body).length).toBe(
      lpField('operator').length + lpOf(pubkey).length + lpOf(nonce).length + lpOf(evidence).length + 4 + 4,
    );
  });

  it('sends an empty evidence field when this browser holds no key', () => {
    const body = buildSignInBody('steward', pubkey, nonce, new Uint8Array(0), 'a-real-password-here', '');
    const afterKindAndKeys = lpField('steward').length + lpOf(pubkey).length + lpOf(nonce).length;
    expect(Array.from(body).slice(afterKindAndKeys, afterKindAndKeys + 4)).toEqual([0, 0, 0, 0]);
  });

  it('trims the code, because a pasted one carries whitespace and the server does not trim', () => {
    const body = buildSignInBody('steward', pubkey, nonce, new Uint8Array(0), 'p', ' 000111 \n');
    expect(Array.from(body).slice(-10)).toEqual(lpField('000111'));
  });
});

// ---------------------------------------------------------------------
// The two-step sign-in, and the challenge the middle of it leaves unspent.
//
// ADR-0056 decision 3 as this round settles it: the second-factor answer is
// a ROLLBACK, not a refusal -- nothing sealed, nothing counted, and the
// nonce still good -- so the second post is the FIRST challenge again with
// the code beside the password. If this client asked for a second challenge
// there, an ordinary two-step sign-in would cost two challenges where a
// one-shot sign-in cost one, which is the thing the contract exists to
// prevent. 2026-09-22.
// ---------------------------------------------------------------------
describe('completeSignIn, twice on one challenge', () => {
  function signInAnswer(): Uint8Array {
    return new Uint8Array([
      ...lpField('01JXSESSIONIDEXAMPLE00000A'),
      ...u32le(32),
      ...new Array(32).fill(5),
      ...u64le(1_790_000_000),
      ...lpField('01JXACCOUNTIDEXAMPLE000001'),
    ]);
  }

  it('re-posts the same nonce and the same evidence, adding only the code', async () => {
    const sessionKeyPair = await generateKeyPair();
    const sessionPubkey = await exportPublicKeyRaw(sessionKeyPair.publicKey);
    const serverNonce = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i));
    const challenge: SignInChallenge = {
      address: 'owner@example.test',
      kind: 'steward',
      sessionKeyPair,
      sessionPubkey,
      serverNonce,
      evidenceSig: new Uint8Array(0),
      pendingSlot: null,
      heldAKey: false,
    };

    const posts: { url: string; body: Uint8Array }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url !== '/session') {
        // `registerBrowserKey`, after the successful post. Best effort in
        // the module, and not what this test is about.
        return new Response('no', { status: 500 });
      }
      posts.push({ url, body: new Uint8Array(init?.body as ArrayBuffer) });
      return posts.length === 1
        ? new Response('second factor needed\n', { status: 401 })
        : new Response(signInAnswer() as BodyInit);
    }) as typeof globalThis.fetch;

    try {
      const probe = await completeSignIn(challenge, { password: 'harbour-lantern-copper' }).catch(
        (e: unknown) => e,
      );
      expect(isSecondFactorNeeded(probe)).toBe(true);
      expect((probe as ApiRefusal).status).toBe(401);

      // The same challenge, handed back. No second `/session/challenge` was
      // asked for -- this call makes exactly one request, to `/session`.
      await completeSignIn(challenge, { password: 'harbour-lantern-copper', verificationCode: '123456' });
    } finally {
      globalThis.fetch = original;
      setSession(null);
    }

    expect(posts.length).toBe(2);
    const nonceAt = lpField('steward').length + 4 + sessionPubkey.length;
    const nonceBytes = (body: Uint8Array) => Array.from(body.slice(nonceAt + 4, nonceAt + 4 + 32));
    expect(nonceBytes(posts[0].body)).toEqual(Array.from(serverNonce));
    expect(nonceBytes(posts[1].body)).toEqual(Array.from(serverNonce));
    // Everything up to the password field is byte-for-byte the same request.
    const uptoPassword = nonceAt + 4 + 32 + 4;
    expect(Array.from(posts[1].body.slice(0, uptoPassword))).toEqual(
      Array.from(posts[0].body.slice(0, uptoPassword)),
    );
    // The first post carries an empty code; the second carries the code.
    expect(Array.from(posts[0].body).slice(-4)).toEqual([0, 0, 0, 0]);
    expect(Array.from(posts[1].body).slice(-10)).toEqual(lpField('123456'));
  });
});
