// Whether this deployment has been set up yet, and whether a setup token is
// live — ADR-0056 decisions 1 and 2, against the two routes the server stream
// adds to `crates/fathom-server/src/api.rs`:
//
// | Route | Signed | Body | Answer |
// |---|---|---|---|
// | `GET /setup/state` | no | — | `LP("pending" \| "done")` |
// | `POST /enrolment/operator/setup/check` | no | `LP(token)` | `LP(address)` |
//
// Both are unauthenticated by construction: there is no session before the
// first operator has a password, so they go through plain `fetch` and
// `refusalFrom`, exactly as `./auth.ts`'s challenge and `./credentials.ts`'s
// setup and reset routes do.
//
// **What the state route says and what it does not.** One bit about the
// deployment — "the first operator has no stored password yet" — and never a
// bit about an address, which is what keeps the per-address answers identical
// in content and in time (ADR-0056 decision 1, OWASP ASVS 5.0.0 6.3.8 as
// ADR-0055 cites it). The check route is a read: it spends nothing and writes
// no chain entry, and it answers one sentence for wrong, spent, expired and
// malformed alike, so nothing here may interpret which of the four it was.
// 2026-09-22.

import { useEffect, useState } from 'react';

import { concatBytes, lp, readLp } from '../crypto/bytes';
import { ApiRefusal, refusalFrom } from './errors';

const decoder = new TextDecoder();

/**
 * `pending` — the first operator of this deployment has an account with no
 * stored password, so the first-run flow is the only screen there is.
 * `done` — anything else, for ever, including the odd states with no install
 * record and no operator: the first-run screen would have nothing to offer
 * there, so the door is the honest answer.
 */
export type SetupState = 'pending' | 'done';

/** `LP("pending"|"done")`, and nothing after it. A third word is an error and
 * not a third state: a client that guessed at one would decide which screen a
 * whole deployment sees on a word the server never said. */
export function parseSetupState(bytes: Uint8Array): SetupState {
  const { value, rest } = readLp(bytes);
  if (rest.length !== 0) {
    throw new Error(`malformed setup state: ${rest.length} trailing byte(s)`);
  }
  const text = decoder.decode(value).trim();
  if (text !== 'pending' && text !== 'done') {
    throw new Error(`malformed setup state: ${JSON.stringify(text)}`);
  }
  return text;
}

/**
 * How long this client waits for the state route before giving up on it.
 *
 * The route is a cached read on the server and answers in milliseconds, but
 * it is asked at two moments where a hung socket would strand a person:
 * at boot, where a screen is waiting on it, and again in `FirstRun.tsx` after
 * a setup token has been spent, where the alternative to an answer is a flow
 * with no next step. A timeout is a failure like any other here, and both
 * callers treat a failure as "show the sign-in door" -- never as `pending`.
 * 2026-09-22.
 */
const SETUP_STATE_TIMEOUT_MS = 5_000;

export async function fetchSetupState(): Promise<SetupState> {
  const response = await fetch('/setup/state', {
    signal: AbortSignal.timeout(SETUP_STATE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw await refusalFrom(response);
  }
  return parseSetupState(new Uint8Array(await response.arrayBuffer()));
}

/** The one read per page load, on `./placement.ts`'s `consoleFlag()` pattern
 * and for its reason: two components asking the same question of the same
 * page must not be able to get two answers, and the bit cannot change under a
 * page that is already open without that page having done the changing. */
let stateOnce: Promise<SetupState> | null = null;

export function setupState(): Promise<SetupState> {
  if (stateOnce === null) {
    stateOnce = fetchSetupState();
  }
  return stateOnce;
}

/** For a test that needs the next `setupState()` to ask again. Not called by
 * any screen: a page load, or `refreshSetupState()` below, is what refreshes
 * this. */
export function forgetSetupState(): void {
  stateOnce = null;
}

/**
 * Ask again, and let every later caller on this page have the new answer.
 *
 * **The one moment the bit can change under an open page is the one this
 * exists for.** `FirstRun.tsx` spends the setup token; the deployment stops
 * being `pending` at that instant, and if the sign-in straight afterwards
 * fails, the cached `pending` is the thing that would send the person back to
 * a token step for a token that no longer exists. Asking again is how that
 * screen finds out that the only thing left to do is sign in. Nothing else
 * calls this: for every other screen the page load is the refresh.
 * 2026-09-22.
 */
export function refreshSetupState(): Promise<SetupState> {
  stateOnce = fetchSetupState();
  return stateOnce;
}

export type SetupStateHook =
  | { status: 'loading' }
  | { status: 'ready'; state: SetupState }
  | { status: 'error'; message: string };

/**
 * Decision 1's bit, as a hook, asked at boot beside the console-host flag.
 *
 * **An error is not `pending`.** `App.tsx` falls back to the sign-in door on
 * one and logs it, because a server that could not answer is not a server
 * that said this deployment is unconfigured, and showing the first-run flow
 * to everyone on a failed fetch would put a token field in front of a
 * deployment that has been running for a year.
 */
export function useSetupState(): SetupStateHook {
  const [hook, setHook] = useState<SetupStateHook>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setupState()
      .then((state) => {
        if (!cancelled) setHook({ status: 'ready', state });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setHook({
            status: 'error',
            message:
              error instanceof ApiRefusal || error instanceof Error
                ? error.message
                : 'The server did not say whether this deployment has been set up.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return hook;
}

/** `LP(token)` — `POST /enrolment/operator/setup/check`. The 32 raw bytes
 * `./enrolment.ts`'s `parseToken` reads out of the pasted line; the prefix
 * never goes on the wire. */
export function buildSetupCheckBody(token: Uint8Array): Uint8Array {
  return concatBytes(lp(token));
}

/** `LP(address)`, and nothing after it. */
export function parseSetupCheckAnswer(bytes: Uint8Array): string {
  const { value, rest } = readLp(bytes);
  if (rest.length !== 0) {
    throw new Error(`malformed setup check answer: ${rest.length} trailing byte(s)`);
  }
  return decoder.decode(value);
}

/**
 * `POST /enrolment/operator/setup/check` — is this token live, and whose
 * address does it name?
 *
 * A read: the token is not spent and nothing is sealed, so the person may
 * look before they choose a password, and the address is never typed and so
 * can never mismatch (ADR-0056 decision 2 step 1 — the owner's "give an error
 * if the email doesn't match" is met by removing the field). Every refusal is
 * a 401 with one sentence for wrong, spent, expired and malformed alike;
 * `FirstRun.tsx` shows its own copy for it and does not repeat the server's,
 * which is written for the audit trail.
 */
export async function checkSetupToken(token: Uint8Array): Promise<string> {
  const response = await fetch('/enrolment/operator/setup/check', {
    method: 'POST',
    body: buildSetupCheckBody(token) as BodyInit,
  });
  if (!response.ok) {
    throw await refusalFrom(response);
  }
  return parseSetupCheckAnswer(new Uint8Array(await response.arrayBuffer()));
}
