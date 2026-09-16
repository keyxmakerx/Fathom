// The enrolment flow: `POST /enrolment/account`. `crates/fathom-server/src/
// admin.rs`'s `redeem_account` doc comment gives the exact body and answer
// shapes; `crates/fathom-server/src/operators.rs`'s
// `redeem_account_enrolment` gives what is checked and the one refusal every
// cause produces. This module assembles and reads exactly those bytes and
// nothing else.
//
// The state machine below exists because the server commits the enrolment
// the instant it answers OK (`operators.rs`: the guarded `UPDATE` and the
// key enrolment commit in the same transaction), but this browser only
// learns that by reading the response -- and reading a response can itself
// fail after the server has already committed. A key generated here and
// never durably kept is then a key the server trusts that nobody can use.
// See `../../docs/OPEN-QUESTIONS.md` D12.

import { concatBytes, fromHex, lp, readLp, utf8 } from '../crypto/bytes';
import {
  deletePendingKeyPair,
  exportPublicKeyRaw,
  generateKeyPair,
  promotePendingKeyPair,
  putPendingKeyPair,
} from '../crypto/keys';
import { refusalFrom } from './errors';

/**
 * Thrown when the pasted token is not 32 bytes of hex.
 *
 * **Not a server refusal.** The server never sees a token that fails this
 * check -- it is this screen's own format check on what was typed, the same
 * shape `crates/fathom-server/src/main.rs`'s `write_bootstrap_token` writes
 * an enrolment token as (`format!("{byte:02x}")` for each of 32 bytes,
 * "so an operator can read it out of a terminal without a hex dump"). It is
 * kept distinct from [`../api/errors.ts`]'s `ApiRefusal` so this screen never
 * reports a local typo as if the server had refused something.
 */
export class MalformedTokenError extends Error {
  constructor() {
    super('That does not look like an invitation token: paste the 64-character code as given.');
    this.name = 'MalformedTokenError';
  }
}

/**
 * Thrown before any network call is made: this browser could not hold the
 * new keypair even provisionally, so nothing was sent and nothing is spent.
 * The invitation token is exactly as usable as it was before this call.
 */
export class EnrolmentNotAttemptedError extends Error {
  constructor(cause: unknown) {
    super('Could not prepare this browser to hold a new key, so nothing was sent. Try again.');
    this.name = 'EnrolmentNotAttemptedError';
    if (cause instanceof Error) {
      this.cause = cause;
    }
  }
}

/**
 * Thrown when this browser cannot tell whether the server enrolled the new
 * key: the network failed before any status was read, the answer's body
 * could not be parsed, or the local promotion write itself failed. In every
 * one of these cases the pending key is left in this browser -- see
 * `../crypto/keys.ts`'s `putPendingKeyPair` -- so the true answer is
 * findable by trying to sign in with it, never by guessing here.
 */
export class EnrolmentOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super(
      'The server may have accepted this token even though this browser could not confirm it. ' +
        'Try signing in; if that is refused, ask for a new invitation.',
    );
    this.name = 'EnrolmentOutcomeUnknownError';
    if (cause instanceof Error) {
      this.cause = cause;
    }
  }
}

// A token pasted out of an HTML email can carry more than leading/trailing
// whitespace: a mail client may render the 64-character code with a visual
// grouping hyphen, or substitute a non-breaking space (U+00A0) or a soft
// hyphen (U+00AD) for an ordinary one anywhere inside the string, none of
// which would show up to the eye. Strip all of them, everywhere in the
// string, before checking shape. `\s` in a JS regular expression already
// matches U+00A0; it is named explicitly below anyway so this list reads as
// a complete answer to "what gets stripped" without relying on that being
// remembered.
const TOKEN_NOISE_RE = /[\s ­-]/gu;
const TOKEN_HEX_RE = /^[0-9a-f]{64}$/;

/** Parse a pasted token into the 32 raw bytes the wire body carries. Accepts
 * surrounding whitespace, either case, and the whitespace/hyphen/NBSP/soft-
 * hyphen noise described above anywhere inside the string, since a person
 * copying a token out of an email or a terminal may pick any of that up
 * without seeing it.
 *
 * This is this client's own reading of the shape
 * `crates/fathom-server/src/main.rs`'s `write_bootstrap_token` writes --
 * 64 lowercase hex characters, no separators -- pending a shared constant on
 * the server side naming that shape explicitly. */
export function parseToken(input: string): Uint8Array {
  const cleaned = input.replace(TOKEN_NOISE_RE, '').toLowerCase();
  if (!TOKEN_HEX_RE.test(cleaned)) {
    throw new MalformedTokenError();
  }
  return fromHex(cleaned);
}

/**
 * Frame the redemption request body, byte for byte what `admin.rs`'s
 * `redeem_account` reads with `read_fields(&body, 3)`: `LP(token) ‖
 * LP(address) ‖ LP(public_key)`, in that order, and nothing after the third
 * field -- a body carrying a fourth is refused (`admin.rs`'s `read_fields`
 * doc comment) rather than having it quietly ignored. Exported on its own so
 * a test can check this framing without a network call or an IndexedDB.
 */
export function buildRedeemAccountBody(token: Uint8Array, address: string, publicKey: Uint8Array): Uint8Array {
  return concatBytes(lp(token), lp(utf8(address)), lp(publicKey));
}

/**
 * Read the answer: `LP(key_id)`, and nothing else -- what `admin.rs`'s
 * `redeem_account` sends back (`crypto::lp(&mut out, key.as_bytes())` over
 * the `String` `operators.rs`'s `redeem_account_enrolment` returns).
 * Refuses any trailing bytes after that one field as malformed, the same
 * strictness `buildRedeemAccountBody`'s own test demands of the request
 * side. Exported on its own for the same reason as `buildRedeemAccountBody`.
 */
export function parseRedeemAccountResponse(bytes: Uint8Array): string {
  const { value: keyIdBytes, rest } = readLp(bytes);
  if (rest.length !== 0) {
    throw new Error('malformed response: trailing bytes after LP(key_id)');
  }
  return new TextDecoder().decode(keyIdBytes);
}

/**
 * The state machine's decisions, as a pure function from what this browser
 * was able to establish about the server's answer to what it does to the
 * pending key store. Exported so every branch can be tested without a
 * network call or an IndexedDB:
 *
 * - `'ok'` (a definite OK answer, body parsed) -> `'promote'`: move the
 *   pending key to the enrolled slot.
 * - `'refused'` (a definite non-OK status read off a response) ->
 *   `'delete-pending'`: the server did not enrol it.
 * - `'unknown'` (no status could be read, or a status was read but nothing
 *   after it could be trusted) -> `'keep-pending'`: do nothing -- in
 *   particular, never delete.
 */
export type EnrolmentOutcome = 'ok' | 'refused' | 'unknown';
export type EnrolmentAction = 'promote' | 'delete-pending' | 'keep-pending';

export function actionForOutcome(outcome: EnrolmentOutcome): EnrolmentAction {
  switch (outcome) {
    case 'ok':
      return 'promote';
    case 'refused':
      return 'delete-pending';
    case 'unknown':
      return 'keep-pending';
  }
}

/**
 * Redeem an account's invitation token: generate this browser's account
 * keypair -- non-extractable, generated here, its private half never
 * exported (`../crypto/keys.ts`) -- enrol its public half against the
 * account the token names, and store the keypair in this browser under
 * `address` so `signIn` (`./auth.ts`) can use it right away.
 *
 * Body: `LP(token) ‖ LP(address) ‖ LP(public_key)`, byte for byte what
 * `admin.rs`'s `redeem_account` reads with `read_fields(&body, 3)` and what
 * `operators.rs`'s `redeem_account_enrolment(token, address, public_key)`
 * takes in that order -- the token as the raw 32 bytes, the address as
 * UTF-8, the public key as the SEC1 uncompressed point `exportPublicKeyRaw`
 * already produces for a sign-in session key.
 *
 * Every refusal the server can give here is
 * [`OperatorError::EnrolmentRefused`] -- **one message for a token that was
 * never issued, one already redeemed, one past its expiry, and one
 * presented with the wrong address alike** (`operators.rs`'s doc comment on
 * `redeem_account_enrolment`, restated on the error variant itself) -- so
 * this function does not try to tell those apart. It throws the server's own
 * `ApiRefusal` (`./errors.ts`) unchanged, the same class `signIn` throws.
 *
 * The steps, and the file:line correspondence to the state machine described
 * on `actionForOutcome`:
 *
 * 1. Write the new keypair to the PENDING slot before sending anything. If
 *    this fails, stop: nothing has been spent, so this throws
 *    [`EnrolmentNotAttemptedError`] rather than an outcome-shaped error.
 * 2. Send the request. A network failure here is `'unknown'` --
 *    no status was ever read.
 * 3. A non-OK status is `'refused'` -- delete the pending slot and throw the
 *    server's own [`ApiRefusal`] unchanged.
 * 4. An OK status whose body will not parse is `'unknown'` -- the server
 *    already committed; the pending key must not be touched.
 * 5. An OK status that parses is `'ok'` -- promote pending to enrolled. If
 *    that local write itself fails, this is *also* `'unknown'`: the server
 *    committed and this browser cannot currently prove which slot the key
 *    ended up in, so it is left exactly where step 1 put it rather than
 *    guessed at.
 *
 * Returns the enrolled key's id, `LP`-decoded from the answer and otherwise
 * unused by this client today.
 */
export async function redeemAccountEnrolment(token: Uint8Array, address: string): Promise<string> {
  const keyPair = await generateKeyPair();
  const publicKey = await exportPublicKeyRaw(keyPair.publicKey);

  // Step 1 (line above `putPendingKeyPair`): before sending, hold the key
  // provisionally. `actionForOutcome` is not consulted here -- there is no
  // outcome yet, only the precondition for having one at all.
  try {
    await putPendingKeyPair(address, keyPair);
  } catch (cause) {
    throw new EnrolmentNotAttemptedError(cause);
  }

  const body = buildRedeemAccountBody(token, address, publicKey);

  // Step 2: send. A thrown fetch is `actionForOutcome('unknown')` ==
  // `'keep-pending'`, which is a no-op -- so nothing is called here beyond
  // leaving the pending entry exactly as step 1 left it.
  let response: Response;
  try {
    response = await fetch('/enrolment/account', {
      method: 'POST',
      body: body as BodyInit,
    });
  } catch (cause) {
    throw new EnrolmentOutcomeUnknownError(cause);
  }

  // Step 3: a definite refusal, read off a real status.
  if (!response.ok) {
    const refusal = await refusalFrom(response);
    if (actionForOutcome('refused') === 'delete-pending') {
      // Best effort: if this delete itself fails, the pending entry is a
      // key the server refused to enrol sitting in this browser. `signIn`
      // will try it, be refused once by the server, and nothing worse
      // follows -- see `../crypto/keys.ts` and `./auth.ts`.
      await deletePendingKeyPair(address).catch(() => {});
    }
    throw refusal;
  }

  // Step 4: OK was read, but the body might not be.
  let keyId: string;
  try {
    const out = new Uint8Array(await response.arrayBuffer());
    keyId = parseRedeemAccountResponse(out);
  } catch (cause) {
    throw new EnrolmentOutcomeUnknownError(cause);
  }

  // Step 5: a definite OK, fully read. Promote.
  if (actionForOutcome('ok') === 'promote') {
    try {
      await promotePendingKeyPair(address);
    } catch (cause) {
      throw new EnrolmentOutcomeUnknownError(cause);
    }
  }

  // Best-effort request that this origin's storage not be evicted under
  // pressure. Per the Storage Standard (https://storage.spec.whatwg.org/,
  // `StorageManager.persist()`, read 2026-09-16 via MDN's mirror of that
  // spec text since the spec itself was unreachable from here): the browser
  // may grant or refuse the request by its own rules, and the returned
  // promise resolves to whether the origin's storage is now in "persistent"
  // mode -- it never throws for a plain refusal. The result is intentionally
  // ignored here: an enrolled key sits in the same "best-uneviction-effort"
  // IndexedDB storage regardless, and this call cannot make that worse, only
  // possibly better.
  if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
    await navigator.storage.persist().catch(() => {});
  }

  return keyId;
}
