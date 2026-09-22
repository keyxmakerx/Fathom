// What step two of the sign-in door actually posts, and how many times.
//
// The branch is about elapsed time -- a person who reads a code straight off
// their phone against one who goes to find it -- so the clock is faked and
// moved, rather than asserted about in the abstract. `../api/auth` is stubbed
// whole: the question here is which of its calls step two makes, not what
// they put on the wire, which `api/auth.test.ts` owns.
//
// **Written 2026-09-22 with the arm it replaces.** Step two used to carry a
// transparent retry: post the held challenge, and if the refusal came back
// after the nonce had certainly died, fetch a fresh challenge and post the
// code once more. It could never run -- entering the branch needed under 90
// seconds elapsed and firing the retry needed 120 or more by the time the
// answer arrived. It is gone, and what is left is the pre-emptive refresh
// these two tests pin: one post, on a challenge that is worth posting.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const beginSignIn = vi.fn();
const completeSignIn = vi.fn();
const signIn = vi.fn();

vi.mock('../api/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api/auth')>();
  return {
    ...real,
    beginSignIn: (...args: unknown[]) => beginSignIn(...args),
    completeSignIn: (...args: unknown[]) => completeSignIn(...args),
    signIn: (...args: unknown[]) => signIn(...args),
  };
});

const { CHALLENGE_REUSE_BUDGET_MS, postSecondStep } = await import('./SignIn');
type SecondFactorState = import('./SignIn').SecondFactorState;

const ADDRESS = 'owner@example.test';
const CREDENTIALS = { password: 'a-long-enough-password', verificationCode: '123456' };

/** Stands in for the challenge step one was left holding. Nothing here reads
 * inside it; it is the object identity that the assertions are about. */
const HELD = { held: true } as unknown as NonNullable<SecondFactorState['challenge']>;

beforeEach(() => {
  vi.useFakeTimers();
  beginSignIn.mockReset();
  completeSignIn.mockReset();
  signIn.mockReset();
  completeSignIn.mockResolvedValue(undefined);
  signIn.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('step two of the door, when the code is typed straight away', () => {
  it('posts the challenge it is holding, and fetches no new one', async () => {
    const step: SecondFactorState = { address: ADDRESS, challenge: HELD, issuedAtMs: Date.now() };

    vi.advanceTimersByTime(10_000);
    await postSecondStep(step, CREDENTIALS);

    // One post, on the challenge the probe left unspent: that is the whole
    // reason ADR-0056 decision 3 rolls the probe back instead of refusing.
    expect(completeSignIn).toHaveBeenCalledTimes(1);
    expect(completeSignIn).toHaveBeenCalledWith(HELD, CREDENTIALS);
    expect(beginSignIn).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
  });
});

describe('step two of the door, when the person went to find their phone', () => {
  it('replaces a challenge older than the budget before it posts, and posts once', async () => {
    const step: SecondFactorState = { address: ADDRESS, challenge: HELD, issuedAtMs: Date.now() };

    // A hundred seconds: past the ninety this client will reuse, and inside
    // the server's own 120-second nonce lifetime, which is exactly the gap
    // the deleted retry arm claimed to cover and could not reach.
    vi.advanceTimersByTime(100_000);
    expect(100_000).toBeGreaterThan(CHALLENGE_REUSE_BUDGET_MS);
    await postSecondStep(step, CREDENTIALS);

    // `signIn` is the fresh challenge and the one post, back to back. The
    // held challenge is never put on the wire.
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(signIn).toHaveBeenCalledWith(ADDRESS, undefined, CREDENTIALS);
    expect(completeSignIn).not.toHaveBeenCalled();
  });

  it('asks for its own challenge when a refusal has already consumed one', async () => {
    // A refused code is a sealed, counted refusal and it spends the nonce,
    // so the try after it has nothing to hold.
    const step: SecondFactorState = { address: ADDRESS, challenge: null, issuedAtMs: Date.now() };

    await postSecondStep(step, CREDENTIALS);

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(completeSignIn).not.toHaveBeenCalled();
  });
});
