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
 * (`credentials::CredentialError::TotpAlreadyEnrolled`). When the server
 * sends one it sends a sentence with it, and that sentence is shown
 * verbatim: replacing an authenticator app is a recovery and not a form, and
 * the uniform *"sign-in refused"* reads as though the person had got
 * something wrong.
 *
 * **Every other refusal keeps the wording it has today.** `api.rs` fixes one
 * sentence per status and sends the real reason nowhere but its own log --
 * *"a refusal that explained itself would tell an attacker which of the
 * checks they failed"* -- so nothing here interprets, translates or guesses
 * at a cause. On a server that does not send the 409 yet, this function is
 * the existing copy, unchanged.
 */
export function describeAppCodeRefusal(error: unknown): string {
  if (error instanceof ApiRefusal && error.status === 409) {
    const sentence = error.message.trim();
    if (sentence.length > 0 && sentence !== 'refused') {
      return sentence;
    }
    // A 409 with nothing in it still means what 409 means here, and saying
    // so is honest; inventing a longer explanation would not be.
    return 'This account already has an authenticator app. Replacing one is a recovery, not a form: it goes through the host command.';
  }
  if (error instanceof ApiRefusal) {
    return error.retryAfterSeconds != null
      ? `${error.message} Try again in ${error.retryAfterSeconds}s.`
      : error.message;
  }
  return 'That did not complete. See the console for detail.';
}
