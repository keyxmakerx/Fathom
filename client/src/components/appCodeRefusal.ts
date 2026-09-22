// What the account screen says when an authenticator-app act is refused.
//
// A pure function in its own module because the client's test runner is
// `environment: 'node'` (`client/vitest.config.ts`) and a sentence nobody can
// test is a sentence nobody can check the wording of. `appCodeRefusal.test.ts`
// drives every branch.
//
// **The file and the function keep their names** (ADR-0056 decision 4, which
// renames what a person reads and leaves routes, columns and identifiers
// alone): `totp` is the route family this refusal comes from, and the module
// is named after the server's refusal rather than after the screen.
// Re-dated 2026-09-22 when the sentences changed.

import { ApiRefusal } from '../api/errors';

/**
 * **409 is the typed refusal for "this account already has a second factor"**
 * (`credentials::CredentialError::TotpAlreadyEnrolled`), and this client maps
 * it **by status**, to its own sentence.
 *
 * It used to print the server's body verbatim. That was wrong twice over:
 *
 * - **The wording is not this client's to control.** The sentence on the wire
 *   was written for the server's own log and names an ADR by number; at the
 *   time of the finding it also carried a name ADR-0056 decision 4 takes out
 *   of everything a person reads. A client that prints whatever arrives
 *   cannot promise what any screen says, and the promise is the decision.
 * - **A server body is not a screen.** The rest of `api.rs` fixes one uniform
 *   sentence per status on purpose — *"a refusal that explained itself would
 *   tell an attacker which of the checks they failed"* — so the one route
 *   that does explain itself is the exception, and reading it out is the
 *   client choosing to relay something it did not write.
 *
 * Mapping by status is what makes the wording testable: whatever the server
 * sends, this is what the person sees, and the test feeds it the server's
 * real sentence to prove the body goes nowhere.
 *
 * **Every other refusal keeps the wording it has today.** Nothing here
 * interprets, translates or guesses at a cause.
 */
export function describeAppCodeRefusal(error: unknown): string {
  if (error instanceof ApiRefusal && error.status === 409) {
    return ALREADY_ENROLLED;
  }
  if (error instanceof ApiRefusal) {
    return error.retryAfterSeconds != null
      ? `${error.message} Try again in ${error.retryAfterSeconds}s.`
      : error.message;
  }
  return 'That did not complete. See the console for detail.';
}

/** The one sentence a 409 on the enrolment route turns into, in this client's
 * own words: what happened, and the one way through it (ADR-0055 decision 8's
 * host command, which the console's notices name the same way). */
const ALREADY_ENROLLED =
  'This account already has a confirmed authenticator. Replacing it is a recovery, done from the host with fathom-server recover-operator.';
