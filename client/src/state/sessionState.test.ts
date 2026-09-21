import { afterEach, describe, expect, it } from 'vitest';

import {
  ACCOUNT_PLANE,
  getPlane,
  getSession,
  getSessionOn,
  heldSessions,
  nextRequestCounter,
  OPERATOR_PLANE,
  planeForPath,
  planeOfKind,
  sessionForPath,
  setPlane,
  setSession,
  subscribe,
} from './sessionState';

function aSession(accountId: string) {
  return {
    kind: 'steward' as const,
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

function anOperatorSession(sessionId = '01JXOPSESSION0000000000001') {
  return {
    kind: 'operator' as const,
    sessionId,
    token: new Uint8Array(32),
    sessionKeyPair: {} as CryptoKeyPair,
    expiresAtUnix: 1_790_000_000,
    address: '01JXOPERATOR00000000000001',
    accountId: '01JXOPERATOR00000000000001',
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

// ADR-0055 decision 1: one person, two custodies. The browser holds the
// account session and the operator session at the same time.
describe('sessionState: two sessions at once', () => {
  afterEach(() => {
    setSession(null);
  });

  it('holds both, and each plane keeps its own', () => {
    setSession(aSession('01JXACCOUNTIDEXAMPLE000007'));
    setSession(anOperatorSession());
    expect(getSessionOn(ACCOUNT_PLANE)?.kind).toBe('steward');
    expect(getSessionOn(OPERATOR_PLANE)?.kind).toBe('operator');
    expect(heldSessions().map((h) => h.plane)).toEqual([ACCOUNT_PLANE, OPERATOR_PLANE]);
  });

  it('files a session on the plane its kind belongs to and brings it into view', () => {
    expect(planeOfKind('steward')).toBe(ACCOUNT_PLANE);
    expect(planeOfKind('operator')).toBe(OPERATOR_PLANE);
    setSession(aSession('01JXACCOUNTIDEXAMPLE000008'));
    expect(getPlane()).toBe(ACCOUNT_PLANE);
    setSession(anOperatorSession());
    expect(getPlane()).toBe(OPERATOR_PLANE);
    expect(getSession()?.kind).toBe('operator');
  });

  it('keeps the account session alive when the operator session is installed', () => {
    const account = aSession('01JXACCOUNTIDEXAMPLE000009');
    setSession(account);
    setSession(anOperatorSession());
    expect(getSessionOn(ACCOUNT_PLANE)).toBe(account);
  });

  it('goes back to Home without a sign-in: setPlane changes the view, not the sessions', () => {
    setSession(aSession('01JXACCOUNTIDEXAMPLE000010'));
    setSession(anOperatorSession());
    setPlane(ACCOUNT_PLANE);
    expect(getPlane()).toBe(ACCOUNT_PLANE);
    expect(getSession()?.kind).toBe('steward');
    // And back again, still with no sign-in.
    setPlane(OPERATOR_PLANE);
    expect(getSession()?.kind).toBe('operator');
    expect(heldSessions()).toHaveLength(2);
  });

  it('refuses to put an empty plane in view', () => {
    setSession(aSession('01JXACCOUNTIDEXAMPLE000011'));
    setPlane(OPERATOR_PLANE);
    expect(getPlane()).toBe(ACCOUNT_PLANE);
    expect(getSession()?.kind).toBe('steward');
  });

  it('notifies subscribers on a change of plane, so the shell re-renders', () => {
    setSession(aSession('01JXACCOUNTIDEXAMPLE000012'));
    setSession(anOperatorSession());
    let calls = 0;
    const unsubscribe = subscribe(() => {
      calls += 1;
    });
    setPlane(ACCOUNT_PLANE);
    // Already there: nothing changed, so nothing is announced.
    setPlane(ACCOUNT_PLANE);
    unsubscribe();
    expect(calls).toBe(1);
  });

  it('ends BOTH sessions on sign-out', () => {
    setSession(aSession('01JXACCOUNTIDEXAMPLE000013'));
    setSession(anOperatorSession());
    setSession(null);
    expect(heldSessions()).toEqual([]);
    expect(getSessionOn(ACCOUNT_PLANE)).toBeNull();
    expect(getSessionOn(OPERATOR_PLANE)).toBeNull();
    expect(getPlane()).toBe(ACCOUNT_PLANE);
  });
});

// The server's request counter is monotone per session row (`GREATEST` in
// `sessions.rs`), so two sessions sharing one counter would refuse each
// other's next request as `CounterNotFresh`.
describe('sessionState: one request counter per session', () => {
  afterEach(() => {
    setSession(null);
  });

  it('counts each plane separately, and neither spends the other’s numbers', () => {
    setSession(aSession('01JXACCOUNTIDEXAMPLE000014'));
    expect(nextRequestCounter(ACCOUNT_PLANE)).toBe(1);
    expect(nextRequestCounter(ACCOUNT_PLANE)).toBe(2);
    setSession(anOperatorSession());
    expect(nextRequestCounter(OPERATOR_PLANE)).toBe(1);
    expect(nextRequestCounter(OPERATOR_PLANE)).toBe(2);
    // The account's counter carried on where it was: setting the operator
    // session did not reset it, so a request made after coming back to Home
    // is still strictly greater than the last one this session made.
    expect(nextRequestCounter(ACCOUNT_PLANE)).toBe(3);
  });

  it('carries on across a change of plane and back', () => {
    setSession(aSession('01JXACCOUNTIDEXAMPLE000015'));
    setSession(anOperatorSession());
    expect(nextRequestCounter()).toBe(1);
    setPlane(ACCOUNT_PLANE);
    expect(nextRequestCounter()).toBe(1);
    setPlane(OPERATOR_PLANE);
    expect(nextRequestCounter()).toBe(2);
  });

  it('starts a replacement session on the same plane at one again', () => {
    setSession(aSession('01JXACCOUNTIDEXAMPLE000016'));
    expect(nextRequestCounter()).toBe(1);
    setSession(anOperatorSession());
    expect(nextRequestCounter()).toBe(1);
    setSession(anOperatorSession('01JXOPSESSION0000000000002'));
    expect(nextRequestCounter()).toBe(1);
  });
});

// Which session signs which request.
describe('sessionState: the plane a path belongs to', () => {
  afterEach(() => {
    setSession(null);
  });

  it('puts everything under /admin on the operator plane', () => {
    expect(planeForPath('/admin/operators')).toBe(OPERATOR_PLANE);
    expect(planeForPath('/admin/placement')).toBe(OPERATOR_PLANE);
    expect(planeForPath('/admin/settings')).toBe(OPERATOR_PLANE);
    expect(planeForPath('/admin/operators/self/key')).toBe(OPERATOR_PLANE);
    expect(planeForPath('/admin')).toBe(OPERATOR_PLANE);
  });

  it('puts everything else on the account plane, including look-alikes', () => {
    expect(planeForPath('/designs')).toBe(ACCOUNT_PLANE);
    expect(planeForPath('/credentials/totp/enrol')).toBe(ACCOUNT_PLANE);
    expect(planeForPath('/session')).toBe(ACCOUNT_PLANE);
    expect(planeForPath('/session/nonce')).toBe(ACCOUNT_PLANE);
    // Not `/admin`: a route whose name merely starts with those letters is
    // not the operator plane.
    expect(planeForPath('/administration')).toBe(ACCOUNT_PLANE);
    expect(planeForPath('/organisations/admin')).toBe(ACCOUNT_PLANE);
  });

  it('signs an /admin request with the operator session when there is one', () => {
    setSession(aSession('01JXACCOUNTIDEXAMPLE000017'));
    setSession(anOperatorSession());
    const chosen = sessionForPath('/admin/operators');
    expect(chosen?.plane).toBe(OPERATOR_PLANE);
    expect(chosen?.session.kind).toBe('operator');
  });

  it('signs an ordinary request with the account session even from the console', () => {
    setSession(aSession('01JXACCOUNTIDEXAMPLE000018'));
    setSession(anOperatorSession());
    expect(getPlane()).toBe(OPERATOR_PLANE);
    const chosen = sessionForPath('/designs');
    expect(chosen?.plane).toBe(ACCOUNT_PLANE);
    expect(chosen?.session.kind).toBe('steward');
  });

  it('carries POST /admin/operators/self/key under the ACCOUNT session, which is the one act that needs it', () => {
    // Before the custody is picked up there is no operator session at all,
    // and this is the request that asks for one.
    setSession(aSession('01JXACCOUNTIDEXAMPLE000019'));
    const chosen = sessionForPath('/admin/operators/self/key');
    expect(chosen?.plane).toBe(ACCOUNT_PLANE);
    expect(chosen?.session.kind).toBe('steward');
  });

  it('has nothing to sign with when no session is held', () => {
    expect(sessionForPath('/designs')).toBeNull();
    expect(sessionForPath('/admin/operators')).toBeNull();
  });
});
