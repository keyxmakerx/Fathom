import { afterEach, describe, expect, it } from 'vitest';

import { getSession, nextRequestCounter, setSession, subscribe } from './sessionState';

function aSession(accountId: string) {
  return {
    sessionId: '01JXSESSIONIDEXAMPLE00000A',
    token: new Uint8Array(32),
    // Never exercised as a real key pair here; `setSession` stores it
    // opaquely and nothing in this module reads its methods.
    sessionKeyPair: {} as CryptoKeyPair,
    expiresAtUnix: 1_790_000_000,
    address: 'steward@example.com',
    accountId,
  };
}

describe('sessionState (ADR-0053 §3: the actor every command is stamped with)', () => {
  afterEach(() => {
    setSession(null);
  });

  it('carries the account id set by setSession back out of getSession', () => {
    const accountId = '01JXACCOUNTIDEXAMPLE000001';
    setSession(aSession(accountId));
    expect(getSession()?.accountId).toBe(accountId);
  });

  it('clears accountId along with the rest of the session on sign-out', () => {
    setSession(aSession('01JXACCOUNTIDEXAMPLE000002'));
    setSession(null);
    expect(getSession()).toBeNull();
  });

  it('notifies subscribers when the account id changes with a new sign-in', () => {
    let calls = 0;
    const unsubscribe = subscribe(() => {
      calls += 1;
    });
    setSession(aSession('01JXACCOUNTIDEXAMPLE000003'));
    setSession(aSession('01JXACCOUNTIDEXAMPLE000004'));
    unsubscribe();
    expect(calls).toBe(2);
  });

  it('resets the request counter on every setSession call, sign-in or sign-out alike', () => {
    setSession(aSession('01JXACCOUNTIDEXAMPLE000005'));
    expect(nextRequestCounter()).toBe(1);
    expect(nextRequestCounter()).toBe(2);
    setSession(aSession('01JXACCOUNTIDEXAMPLE000006'));
    expect(nextRequestCounter()).toBe(1);
  });
});
