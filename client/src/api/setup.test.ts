// The bytes ADR-0056's two new routes carry, and what this client refuses to
// read into them.
//
// Every vector below was produced by a Python one-liner from the route's own
// shape -- `struct.pack('<I', len) + bytes` per LP field -- and never by this
// module's own encoder, the method `api/placement.test.ts` and
// `api/console.test.ts` already document: a test that asked the encoder what
// the encoder produces would pass while the wire was wrong. 2026-09-22.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fromHex, toHex } from '../crypto/bytes';
import {
  buildSetupCheckBody,
  checkSetupToken,
  fetchSetupState,
  forgetSetupState,
  parseSetupCheckAnswer,
  parseSetupState,
  refreshSetupState,
  SETUP_STATE_MAX_WAIT_SECONDS,
  setupState,
  setupStateRetryDelayMs,
} from './setup';
import { ApiRefusal } from './errors';

const TOKEN = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');

/** Swap `fetch` for the length of one call and put it back, the shape
 * `api/credentials.test.ts` uses. */
async function withFetch<T>(stub: typeof globalThis.fetch, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = stub;
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

describe('parseSetupState (GET /setup/state)', () => {
  it('reads the two words the route can say', () => {
    expect(parseSetupState(fromHex('0700000070656e64696e67'))).toBe('pending');
    expect(parseSetupState(fromHex('04000000646f6e65'))).toBe('done');
  });

  it('refuses a third word rather than inventing a third state', () => {
    // ADR-0056 decision 1: the bit decides which screen a whole deployment
    // sees. A client that read an unknown word as either answer would be
    // deciding that on something the server never said.
    expect(() => parseSetupState(fromHex('050000006d61796265'))).toThrow(/malformed setup state/);
  });

  it('refuses trailing bytes and a truncated field', () => {
    expect(() => parseSetupState(fromHex('04000000646f6e65ff'))).toThrow(/trailing/);
    expect(() => parseSetupState(fromHex('04000000646f6e'))).toThrow(/truncated/);
  });
});

describe('fetchSetupState', () => {
  it('asks the unauthenticated route and reads the word off it', async () => {
    const seen: string[] = [];
    const state = await withFetch(
      (async (input: RequestInfo | URL) => {
        seen.push(String(input));
        return new Response(fromHex('0700000070656e64696e67') as BodyInit);
      }) as typeof globalThis.fetch,
      fetchSetupState,
    );
    expect(seen).toEqual(['/setup/state']);
    expect(state).toBe('pending');
  });

  it('throws the server’s refusal rather than guessing a state from a failure', async () => {
    const error = await withFetch(
      (async () =>
        new Response('too many requests\n', {
          status: 429,
          headers: { 'retry-after': '0' },
        })) as typeof globalThis.fetch,
      () => fetchSetupState().catch((e: unknown) => e),
    );
    expect(error).toBeInstanceOf(ApiRefusal);
    expect((error as ApiRefusal).status).toBe(429);
  });

  it('waits what a 429 asks for and asks once more before it gives up', async () => {
    // The state route has its own per-source bucket, so a 429 on it is a
    // "not now" and never a verdict about this deployment. Falling straight
    // through on the first one would take the first-run screen away from an
    // install that has not been set up, for a reason that is about the
    // office's address and not about the install.
    let calls = 0;
    const state = await withFetch(
      (async () => {
        calls += 1;
        return calls === 1
          ? new Response('too many requests\n', { status: 429, headers: { 'retry-after': '0' } })
          : new Response(fromHex('0700000070656e64696e67') as BodyInit);
      }) as typeof globalThis.fetch,
      fetchSetupState,
    );
    expect(calls).toBe(2);
    expect(state).toBe('pending');
  });

  it('asks once more and no further', async () => {
    let calls = 0;
    const error = await withFetch(
      (async () => {
        calls += 1;
        return new Response('too many requests\n', {
          status: 429,
          headers: { 'retry-after': '0' },
        });
      }) as typeof globalThis.fetch,
      () => fetchSetupState().catch((e: unknown) => e),
    );
    expect(calls).toBe(2);
    expect(error).toBeInstanceOf(ApiRefusal);
  });

  it('does not retry anything but a 429', async () => {
    let calls = 0;
    const error = await withFetch(
      (async () => {
        calls += 1;
        return new Response('refused\n', { status: 500 });
      }) as typeof globalThis.fetch,
      () => fetchSetupState().catch((e: unknown) => e),
    );
    expect(calls).toBe(1);
    expect((error as ApiRefusal).status).toBe(500);
  });
});

describe('the wait a 429 on the state route actually takes', () => {
  // The four tests above send `retry-after: 0`, which is a wait that cannot
  // be told from no wait at all: they prove the second ask happens and
  // nothing about when. These two move a fake clock, so the pause between
  // the two fetches is the thing being asserted. 2026-09-22.
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Count the fetches, refuse the first with `retry-after`, answer the
   * second. Returns the counter and the promise, unawaited: the point is what
   * is true *before* the clock moves. */
  function refuseThenAnswer(retryAfterSeconds: number) {
    const calls = { n: 0 };
    const stub = (async () => {
      calls.n += 1;
      return calls.n === 1
        ? new Response('too many requests\n', {
            status: 429,
            headers: { 'retry-after': String(retryAfterSeconds) },
          })
        : new Response(fromHex('0700000070656e64696e67') as BodyInit);
    }) as typeof globalThis.fetch;
    return { calls, stub };
  }

  it('waits the five seconds the server asked for, and not a moment less', async () => {
    vi.useFakeTimers();
    const { calls, stub } = refuseThenAnswer(5);
    const original = globalThis.fetch;
    globalThis.fetch = stub;
    try {
      const pending = fetchSetupState();
      // The refusal has been read; the second ask is behind the wait.
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.n).toBe(1);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(calls.n).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls.n).toBe(2);
      await expect(pending).resolves.toBe('pending');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('bounds a two-minute ask to thirty seconds rather than blanking the page', async () => {
    // A `Retry-After` of two minutes is two minutes of nothing on screen.
    // The door, wrong as it is on a pending deployment, is a screen a person
    // can act on, so the wait is capped and the second ask made.
    vi.useFakeTimers();
    const { calls, stub } = refuseThenAnswer(120);
    const original = globalThis.fetch;
    globalThis.fetch = stub;
    try {
      const pending = fetchSetupState();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.n).toBe(1);
      await vi.advanceTimersByTimeAsync(SETUP_STATE_MAX_WAIT_SECONDS * 1_000 - 1);
      expect(calls.n).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls.n).toBe(2);
      await expect(pending).resolves.toBe('pending');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('how long a 429 on the state route is allowed to hold the screen', () => {
  it('honours the server’s number, bounded, and never waits on a negative one', () => {
    expect(setupStateRetryDelayMs(3)).toBe(3_000);
    expect(setupStateRetryDelayMs(SETUP_STATE_MAX_WAIT_SECONDS)).toBe(
      SETUP_STATE_MAX_WAIT_SECONDS * 1_000,
    );
    // A `Retry-After` of half an hour is a blank page for half an hour; the
    // door, wrong as it is on a pending deployment, is a screen a person can
    // act on.
    expect(setupStateRetryDelayMs(1_800)).toBe(SETUP_STATE_MAX_WAIT_SECONDS * 1_000);
    expect(setupStateRetryDelayMs(-5)).toBe(0);
    // No header at all: a proxy in front of the server that dropped it.
    expect(setupStateRetryDelayMs(null)).toBe(1_000);
  });
});

describe('setupState(), the one read per page load', () => {
  it('asks once and hands the same answer to every later caller', async () => {
    forgetSetupState();
    let calls = 0;
    const [first, second] = await withFetch(
      (async () => {
        calls += 1;
        return new Response(fromHex('04000000646f6e65') as BodyInit);
      }) as typeof globalThis.fetch,
      async () => [await setupState(), await setupState()],
    );
    expect(calls).toBe(1);
    expect(first).toBe('done');
    expect(second).toBe('done');
    forgetSetupState();
  });
});

describe('refreshSetupState(), the one moment the bit can change', () => {
  it('asks again and hands the new answer to every later caller', async () => {
    // `FirstRun.tsx` spends the setup token, which is what makes this
    // deployment stop being `pending`. If the sign-in after it fails, the
    // cached `pending` is the one thing that would send the person back to a
    // token step for a token that no longer exists.
    forgetSetupState();
    const answers = ['0700000070656e64696e67', '04000000646f6e65'];
    let calls = 0;
    const [first, second, cached] = await withFetch(
      (async () => {
        const body = answers[Math.min(calls, answers.length - 1)];
        calls += 1;
        return new Response(fromHex(body) as BodyInit);
      }) as typeof globalThis.fetch,
      async () => [await setupState(), await refreshSetupState(), await setupState()],
    );
    expect(calls).toBe(2);
    expect(first).toBe('pending');
    expect(second).toBe('done');
    expect(cached).toBe('done');
    forgetSetupState();
  });

  it('gives up rather than hanging, and says so as a failure', async () => {
    // The timeout is an `AbortSignal`, so the caller sees a rejection and
    // not a state: a screen that read a hung socket as `pending` would put a
    // token field in front of a deployment that has been running for a year.
    forgetSetupState();
    const seen: (AbortSignal | null | undefined)[] = [];
    const error = await withFetch(
      (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(init?.signal);
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }) as typeof globalThis.fetch,
      () => refreshSetupState().catch((e: unknown) => e),
    );
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(error).toBeInstanceOf(DOMException);
    forgetSetupState();
  });
});

describe('POST /enrolment/operator/setup/check', () => {
  it('frames the token as one LP field', () => {
    expect(toHex(buildSetupCheckBody(TOKEN))).toBe(
      '200000000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
    );
  });

  it('reads the address out of the answer', () => {
    expect(parseSetupCheckAnswer(fromHex('120000006f776e6572406578616d706c652e74657374'))).toBe(
      'owner@example.test',
    );
  });

  it('refuses trailing bytes after the address', () => {
    expect(() =>
      parseSetupCheckAnswer(fromHex('120000006f776e6572406578616d706c652e7465737400')),
    ).toThrow(/trailing/);
  });

  it('posts the body and returns the address the server named', async () => {
    const seen: { url: string; body: string }[] = [];
    const address = await withFetch(
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({
          url: String(input),
          body: toHex(new Uint8Array(init?.body as ArrayBuffer)),
        });
        return new Response(fromHex('120000006f776e6572406578616d706c652e74657374') as BodyInit);
      }) as typeof globalThis.fetch,
      () => checkSetupToken(TOKEN),
    );
    expect(seen[0].url).toBe('/enrolment/operator/setup/check');
    expect(seen[0].body).toBe(toHex(buildSetupCheckBody(TOKEN)));
    expect(address).toBe('owner@example.test');
  });

  it('carries the 401 up as a refusal, whatever the cause was', async () => {
    // Wrong, spent, expired and malformed are one answer on purpose
    // (ADR-0056 decision 2 step 1), so nothing here may tell them apart.
    const error = await withFetch(
      (async () => new Response('setup token refused\n', { status: 401 })) as typeof globalThis.fetch,
      () => checkSetupToken(TOKEN).catch((e: unknown) => e),
    );
    expect(error).toBeInstanceOf(ApiRefusal);
    expect((error as ApiRefusal).status).toBe(401);
    expect((error as ApiRefusal).message).toBe('setup token refused');
  });
});
