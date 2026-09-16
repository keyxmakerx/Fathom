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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fromHex, toHex } from '../crypto/bytes';
import { getEnrolledKeyPair, getPendingKeyPair } from '../crypto/keys';
import { ApiRefusal } from './errors';
import {
  actionForOutcome,
  buildRedeemAccountBody,
  EnrolmentNotAttemptedError,
  EnrolmentOutcomeUnknownError,
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
  function encodeKeyId(keyId: string): Uint8Array {
    const encoded = new TextEncoder().encode(keyId);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, encoded.length, true);
    const response = new Uint8Array(len.length + encoded.length);
    response.set(len, 0);
    response.set(encoded, len.length);
    return response;
  }

  it('reads the single LP(key_id) field the server sends back', () => {
    // crypto::lp(&mut out, key.as_bytes()) over the String operators.rs
    // returns -- one field, UTF-8.
    const keyId = '01JXENROLKEYIDEXAMPLE0000A';
    expect(parseRedeemAccountResponse(encodeKeyId(keyId))).toBe(keyId);
  });

  it('refuses trailing bytes after the one field as malformed', () => {
    // admin.rs sends exactly LP(key_id) and nothing else -- the same
    // strictness `buildRedeemAccountBody`'s own test demands of the request
    // side ("read_fields(&body, 3)... require the remainder to be empty").
    // A byte left over here means either this client's framing
    // understanding is wrong or the wire carried something unexpected;
    // either way it must not be silently dropped.
    const withTrailer = new Uint8Array([...encodeKeyId('01JXENROLKEYIDEXAMPLE0000A'), 0xff]);
    expect(() => parseRedeemAccountResponse(withTrailer)).toThrow(/trailing/);
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

  it('strips an interior non-breaking space (U+00A0), invisible to the eye', () => {
    const hex = 'cd'.repeat(32);
    // A non-breaking space dropped in the middle of the string, the way an
    // HTML email's line-wrapping can silently substitute one for an
    // ordinary space without it ever being visible in a rendered message.
    const withNbsp = `${hex.slice(0, 40)} ${hex.slice(40)}`;
    expect(toHex(parseToken(withNbsp))).toBe(hex);
  });

  it('strips hyphens grouping the token, anywhere in the string', () => {
    const hex = 'ef'.repeat(32);
    // A token rendered in visually-grouped chunks, e.g. by a mail client or
    // a terminal that inserts a hyphen every 8 characters.
    const grouped = hex.match(/.{1,8}/g)!.join('-');
    expect(toHex(parseToken(grouped))).toBe(hex);
  });

  it('rejects anything that is not exactly 32 bytes of hex once noise is stripped', () => {
    expect(() => parseToken('not-a-token')).toThrow(MalformedTokenError);
    expect(() => parseToken('ab'.repeat(31))).toThrow(MalformedTokenError);
    expect(() => parseToken('ab'.repeat(33))).toThrow(MalformedTokenError);
    expect(() => parseToken('')).toThrow(MalformedTokenError);
  });
});

describe('actionForOutcome (the state machine\'s decisions, as a pure function)', () => {
  // Every branch of finding 1's state machine, decoupled from the network
  // and from IndexedDB entirely -- see the "untested" note at the bottom of
  // this file for what calling this from `redeemAccountEnrolment` cannot
  // itself prove under this test runner.
  it('promotes on a definite OK', () => {
    expect(actionForOutcome('ok')).toBe('promote');
  });

  it('deletes the pending slot on a definite refusal', () => {
    expect(actionForOutcome('refused')).toBe('delete-pending');
  });

  it('keeps the pending slot on an unknown outcome -- never deletes', () => {
    expect(actionForOutcome('unknown')).toBe('keep-pending');
  });
});

// ---------------------------------------------------------------------------
// A minimal, hand-written stand-in for the browser's IndexedDB
// ---------------------------------------------------------------------------
//
// `vitest.config.ts` runs this suite under Node (`environment: 'node'`),
// which has no `indexedDB` global and no jsdom -- so real IndexedDB cannot
// run under this test runner at all (per this task's own brief). This stub
// covers only the exact shapes `../crypto/keys.ts` issues against one
// database with two single-key object stores: `open` with an upgrade
// callback, and per-store `get` / `put` / `delete`, each completing on a
// microtask the way the real API does (so a caller that assigns
// `request.onsuccess` *after* calling `.get()`, as `../crypto/keys.ts`
// does, still sees it fire). It is not a claim that this exercises real
// IndexedDB's failure modes -- see the note at the bottom of this file.
function installFakeIndexedDb() {
  const stores = new Map<string, Map<string, unknown>>();

  function ensureStore(name: string): Map<string, unknown> {
    if (!stores.has(name)) {
      stores.set(name, new Map());
    }
    return stores.get(name)!;
  }

  type FakeRequest = { result?: unknown; error?: unknown; onsuccess?: () => void; onerror?: () => void };
  interface FakeStoreHandle {
    get: (key: string) => FakeRequest;
    put: (value: unknown, key: string) => FakeRequest;
    delete: (key: string) => FakeRequest;
  }
  type FakeTx = {
    pending: number;
    done: boolean;
    oncomplete?: () => void;
    onerror?: () => void;
    objectStore: (name: string) => FakeStoreHandle;
  };

  function makeTransaction(): FakeTx {
    // `tx` is the single object returned to the caller; `oncomplete` and
    // `onerror` are read straight off it (not a copy), so an assignment the
    // caller makes *after* getting this object back -- exactly what
    // `../crypto/keys.ts` does -- is what `maybeComplete` below observes.
    const tx: FakeTx = {
      pending: 0,
      done: false,
      objectStore: (name: string): FakeStoreHandle => {
        const store = ensureStore(name);
        return {
          get: (key: string) => trackedRequest(() => store.get(key)),
          put: (value: unknown, key: string) => trackedRequest(() => void store.set(key, value)),
          delete: (key: string) => trackedRequest(() => void store.delete(key)),
        };
      },
    };
    function maybeComplete() {
      queueMicrotask(() => {
        if (!tx.done && tx.pending === 0) {
          tx.done = true;
          tx.oncomplete?.();
        }
      });
    }
    function trackedRequest(run: () => unknown): FakeRequest {
      tx.pending += 1;
      const req: FakeRequest = {};
      queueMicrotask(() => {
        try {
          req.result = run();
          req.onsuccess?.();
        } catch (error) {
          req.error = error;
          req.onerror?.();
        } finally {
          tx.pending -= 1;
          maybeComplete();
        }
      });
      return req;
    }
    // No request has been issued yet; if none ever is, this still fires.
    maybeComplete();
    return tx;
  }

  const fakeDb = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => ensureStore(name),
    close: () => {},
    transaction: (_names: string | string[]) => makeTransaction(),
  };

  vi.stubGlobal('indexedDB', {
    open: () => {
      const req: FakeRequest & { onupgradeneeded?: () => void } = {};
      queueMicrotask(() => {
        req.result = fakeDb;
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  });
}

describe('redeemAccountEnrolment refusals: one message for every cause', () => {
  beforeEach(() => {
    installFakeIndexedDb();
  });

  afterEach(() => {
    // Removes both the fake `indexedDB` stub and whichever `fetch` stub the
    // test installed, so the next describe block -- which depends on
    // `indexedDB` being genuinely absent -- sees exactly that.
    vi.unstubAllGlobals();
  });

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
    }
  });

  it('on a definite refusal, deletes the pending key and leaves no enrolled key behind', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('sign-in refused\n', { status: 401 })),
    );
    await expect(redeemAccountEnrolment(TOKEN, ADDRESS)).rejects.toBeInstanceOf(ApiRefusal);
    expect(await getPendingKeyPair(ADDRESS)).toBeNull();
    expect(await getEnrolledKeyPair(ADDRESS)).toBeNull();
  });

  it('on a definite OK, promotes the pending key to enrolled and clears the pending slot', async () => {
    const keyId = '01JXENROLKEYIDEXAMPLE0000A';
    const encoded = new TextEncoder().encode(keyId);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, encoded.length, true);
    const body = new Uint8Array(len.length + encoded.length);
    body.set(len, 0);
    body.set(encoded, len.length);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    const returnedKeyId = await redeemAccountEnrolment(TOKEN, ADDRESS);
    expect(returnedKeyId).toBe(keyId);
    expect(await getPendingKeyPair(ADDRESS)).toBeNull();
    expect(await getEnrolledKeyPair(ADDRESS)).not.toBeNull();
  });

  it('on a network failure, keeps the pending key and throws EnrolmentOutcomeUnknownError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network error');
      }),
    );
    await expect(redeemAccountEnrolment(TOKEN, ADDRESS)).rejects.toBeInstanceOf(EnrolmentOutcomeUnknownError);
    expect(await getPendingKeyPair(ADDRESS)).not.toBeNull();
    expect(await getEnrolledKeyPair(ADDRESS)).toBeNull();
  });

  it('on an OK status with an unparseable body, keeps the pending key and throws EnrolmentOutcomeUnknownError', async () => {
    // Truncated: a length prefix claiming more bytes than are actually
    // present, so `readLp` throws inside `parseRedeemAccountResponse`.
    const truncated = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(truncated, { status: 200 })),
    );
    await expect(redeemAccountEnrolment(TOKEN, ADDRESS)).rejects.toBeInstanceOf(EnrolmentOutcomeUnknownError);
    expect(await getPendingKeyPair(ADDRESS)).not.toBeNull();
    expect(await getEnrolledKeyPair(ADDRESS)).toBeNull();
  });
});

describe('redeemAccountEnrolment: stopping before the network call', () => {
  it('throws EnrolmentNotAttemptedError, without calling fetch, if the pending write fails', async () => {
    // No fake IndexedDB installed for this test: `indexedDB` is undefined
    // under this runner (see the stub's own doc comment above), so the
    // pending write fails exactly the way a real quota or private-browsing
    // failure would -- before anything is sent.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await expect(redeemAccountEnrolment(TOKEN, ADDRESS)).rejects.toBeInstanceOf(EnrolmentNotAttemptedError);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// What is untested, and why
// ---------------------------------------------------------------------------
//
// `vitest.config.ts` runs this suite under Node, which has no `indexedDB`
// global and no jsdom. The integration tests above run against a small
// hand-written stand-in (`installFakeIndexedDb`), not a real browser
// implementation, so none of the following are exercised by this suite:
//
// - Real IndexedDB failure modes: storage quota exhaustion, private
//   browsing's refusal to persist, a corrupt store, or a version-upgrade
//   conflict with another open tab.
// - Real atomicity/durability guarantees of an IndexedDB transaction
//   spanning two object stores (`promotePendingKeyPair`) -- the fake
//   models the request/transaction *event ordering* faithfully enough for
//   `../crypto/keys.ts`'s code to run correctly against it, but says
//   nothing about the platform's actual durability contract.
// - `navigator.storage.persist()` (`redeemAccountEnrolment`'s last step):
//   not called by any test here, and `navigator` is not stubbed.
// - `../api/auth.ts`'s `signIn` falling back to a pending key and
//   promoting it on success: no test file exists for `auth.ts` in this
//   repository, and this task did not ask for one; that path is exercised
//   only by the reasoning in its doc comment and by this file's coverage of
//   `getPendingKeyPair` / `promotePendingKeyPair` as used from
//   `redeemAccountEnrolment`.
