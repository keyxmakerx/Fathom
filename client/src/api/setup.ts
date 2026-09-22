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
// **The state route has a bucket of its own** (2026-09-22, this round): a
// per-source budget keyed `setup-state`, separate from the sign-in one and far
// larger, because a page load is not a sign-in attempt. Two consequences here:
// a busy office cannot spend its own sign-ins on opening the page, and a `429`
// from this route is a "not now" rather than a verdict — [`fetchSetupState`]
// waits what the server asks for, bounded, and asks once more before anything
// falls back to the sign-in door.
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

/**
 * The longest this client waits on a `429` from the state route before asking
 * again.
 *
 * The route has a per-source bucket of its own, separate from the sign-in one
 * (120 per window, keyed `setup-state`), so an office behind one address can
 * load the page without eating anybody's sign-in attempts. A 429 on it is
 * therefore an ordinary, temporary "not now" rather than a verdict about this
 * deployment — and answering it by falling straight through to the sign-in
 * door would take the first-run screen away from an install that has not been
 * set up. So the wait the server asks for is honoured once, bounded here: a
 * `Retry-After` of half an hour would otherwise be a blank page for half an
 * hour, and the door, wrong as it is on a pending deployment, is a screen a
 * person can act on. 2026-09-22.
 */
export const SETUP_STATE_MAX_WAIT_SECONDS = 30;

/** What a `429` with no `Retry-After` waits. The server sends the header; this
 * is for a proxy in front of it that does not. */
const SETUP_STATE_DEFAULT_WAIT_SECONDS = 1;

/** How long to wait before the one retry, in milliseconds — the server's own
 * number, floored at nothing and capped at
 * [`SETUP_STATE_MAX_WAIT_SECONDS`]. Exported because the bound is the part
 * worth a test, and a test that waited the real time would be the wait. */
export function setupStateRetryDelayMs(retryAfterSeconds: number | null): number {
  const asked = retryAfterSeconds ?? SETUP_STATE_DEFAULT_WAIT_SECONDS;
  return Math.min(Math.max(asked, 0), SETUP_STATE_MAX_WAIT_SECONDS) * 1_000;
}

async function askForSetupState(): Promise<SetupState> {
  const response = await fetch('/setup/state', {
    signal: AbortSignal.timeout(SETUP_STATE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw await refusalFrom(response);
  }
  return parseSetupState(new Uint8Array(await response.arrayBuffer()));
}

/**
 * Ask the route, and on a `429` wait what it asks for — bounded — and ask
 * **once** more.
 *
 * One retry and not a loop: two tries bound what a hung or angry server costs
 * a page load, and the second answer is either the bit or the fallback. Every
 * other failure, including the timeout, is thrown as it is: a client that read
 * a failure as `pending` would put a token field in front of a deployment that
 * has been running for a year.
 */
export async function fetchSetupState(): Promise<SetupState> {
  try {
    return await askForSetupState();
  } catch (error) {
    if (!(error instanceof ApiRefusal) || error.status !== 429) throw error;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, setupStateRetryDelayMs(error.retryAfterSeconds)),
    );
    return askForSetupState();
  }
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
