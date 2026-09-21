// The credential plane: the routes a person uses to set a password, enrol an
// app code, take their backup codes, register this browser's key, and ask for
// a reset. ADR-0055 decision 10, built server-side by stream (a) and spelled
// byte for byte in `crates/fathom-server/src/api.rs`'s
// `credential_router` block.
//
// **Every body and every answer here is length-prefixed**, the framing
// `../crypto/bytes.ts` carries and `crypto::read_lp` reads. The routes, as the
// server has them on 2026-09-21:
//
// | Route | Signed | Body | Answer |
// |---|---|---|---|
// | `POST /enrolment/operator/setup` | no | `LP(token) ‖ LP(password)` | empty |
// | `POST /credentials/password` | yes | `LP(password)` | empty |
// | `POST /credentials/totp/enrol` | yes | empty | `LP(otpauth_uri) ‖ LP(secret)` |
// | `POST /credentials/totp/confirm` | yes | `LP(app_code)` | ten `LP(backup_code)` |
// | `POST /credentials/key` | yes | `LP(public_key)` | `LP(key_id)` |
// | `POST /credentials/reset` | no | `LP(address)` | empty, always |
// | `POST /credentials/reset/redeem` | no | `LP(token) ‖ LP(password)` | empty |
//
// The setup and reset routes are unauthenticated by construction — there is no
// session to sign with yet — so they go through plain `fetch` and
// `refusalFrom`, exactly as `./auth.ts`'s challenge and sign-in do. Everything
// else goes through `./signedFetch.ts`, which is the only way this client
// reaches a route that composes `Signed`.

import { concatBytes, lp, readLp, utf8 } from '../crypto/bytes';
import { exportPublicKeyRaw, generateKeyPair, putEnrolledKeyPair } from '../crypto/keys';
import { ApiRefusal, refusalFrom } from './errors';
import { signedFetch } from './signedFetch';

const EMPTY = new Uint8Array(0);
const decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// The bodies, framed on their own so a test can check the bytes
// ---------------------------------------------------------------------------

/** `LP(token) ‖ LP(password)` — both `POST /enrolment/operator/setup` and
 * `POST /credentials/reset/redeem` take exactly this, and the server reads
 * each with `read_fields(&body, 2)`, which refuses a third field rather than
 * ignoring it. */
export function buildTokenAndPasswordBody(token: Uint8Array, password: string): Uint8Array {
  return concatBytes(lp(token), lp(utf8(password)));
}

/** `LP(password)` — `POST /credentials/password`. */
export function buildPasswordBody(password: string): Uint8Array {
  return concatBytes(lp(utf8(password)));
}

/** `LP(app_code)` — `POST /credentials/totp/confirm`. The code is sent as it
 * was typed apart from the trimming below: `credentials::normalise_code`
 * folds case, hyphens and Crockford's confusable letters on the server, and a
 * client that folded them too would be a second implementation of a rule that
 * has to agree with the stored hash. */
export function buildAppCodeBody(code: string): Uint8Array {
  return concatBytes(lp(utf8(code.trim())));
}

/** `LP(public_key)` — `POST /credentials/key` and, on the operator plane,
 * `POST /admin/operators/self/key`. The key is SEC1 uncompressed, 65 bytes. */
export function buildPublicKeyBody(publicKey: Uint8Array): Uint8Array {
  return concatBytes(lp(publicKey));
}

/** `LP(address)` — `POST /credentials/reset`. */
export function buildAddressBody(address: string): Uint8Array {
  return concatBytes(lp(utf8(address)));
}

// ---------------------------------------------------------------------------
// The answers
// ---------------------------------------------------------------------------

export interface TotpEnrolment {
  /** `otpauth://totp/...`, shown as text. ADR-0055 decision 10: a QR encoder
   * is not in this build, so the URI and the secret are both shown and the
   * person types or copies one of them. */
  otpauthUri: string;
  /** RFC 4648 base32, as the app asks for it. */
  secretBase32: string;
}

/** `LP(otpauth_uri) ‖ LP(secret_base32)`, and nothing after it. */
export function parseTotpEnrolment(bytes: Uint8Array): TotpEnrolment {
  const { value: uri, rest } = readLp(bytes);
  const { value: secret, rest: trailing } = readLp(rest);
  if (trailing.length !== 0) {
    throw new Error('malformed response: trailing bytes after LP(secret_base32)');
  }
  return { otpauthUri: decoder.decode(uri), secretBase32: decoder.decode(secret) };
}

/**
 * The backup codes: one `LP(code)` after another until the body runs out.
 *
 * Ten of them today (`credentials::BACKUP_CODE_COUNT`), each
 * `xxxx-xxxx-xxxx-xxxx`. The count is **not** asserted here — the server's own
 * answer is the truth about how many it minted, and a client that refused
 * eleven would throw away codes the server has already recorded as live. The
 * screen shows however many came back.
 */
export function parseBackupCodes(bytes: Uint8Array): string[] {
  const codes: string[] = [];
  let rest = bytes;
  while (rest.length > 0) {
    const read = readLp(rest);
    codes.push(decoder.decode(read.value));
    rest = read.rest;
  }
  return codes;
}

/** `LP(key_id)`, and nothing after it — `POST /credentials/key`. */
export function parseKeyId(bytes: Uint8Array): string {
  const { value, rest } = readLp(bytes);
  if (rest.length !== 0) {
    throw new Error('malformed response: trailing bytes after LP(key_id)');
  }
  return decoder.decode(value);
}

/** `LP(key_id) ‖ LP(operator_id)` — `POST /admin/operators/self/key`, the same
 * shape `POST /enrolment/operator` answers, because a browser that has just
 * registered an operator key needs to learn which operator it registered for
 * (that id is what the operator signs in as). */
export function parseOperatorKeyAnswer(bytes: Uint8Array): { keyId: string; operatorId: string } {
  const { value: keyId, rest } = readLp(bytes);
  const { value: operatorId, rest: trailing } = readLp(rest);
  if (trailing.length !== 0) {
    throw new Error('malformed response: trailing bytes after LP(operator_id)');
  }
  return { keyId: decoder.decode(keyId), operatorId: decoder.decode(operatorId) };
}

/**
 * `GET /placement/flag`: `LP("yes"|"no")`, and — only when the answer is
 * `"yes"` — a second `LP(confirm_by)` which is empty text when the placement
 * is already confirmed (`placement.rs`'s `flag`).
 *
 * A `"no"` answer carries **one** field, so a parser that insisted on two
 * would throw on exactly the host where the answer matters most.
 */
export function parsePlacementFlag(bytes: Uint8Array): { consoleHost: boolean; confirmBy: number | null } {
  const { value, rest } = readLp(bytes);
  const answer = decoder.decode(value);
  if (answer !== 'yes' && answer !== 'no') {
    throw new Error('malformed /placement/flag response: not "yes" or "no"');
  }
  if (answer === 'no') {
    return { consoleHost: false, confirmBy: null };
  }
  if (rest.length === 0) {
    return { consoleHost: true, confirmBy: null };
  }
  const { value: deadline } = readLp(rest);
  const text = decoder.decode(deadline);
  const parsed = Number.parseInt(text, 10);
  return { consoleHost: true, confirmBy: text.length > 0 && Number.isFinite(parsed) ? parsed : null };
}

// ---------------------------------------------------------------------------
// The refusal that is a route, not a wall
// ---------------------------------------------------------------------------

/**
 * `SessionError::TotpRequired`, as it arrives: **403** and the sentence
 * `api.rs` fixes for it, `enrol an app code first`.
 *
 * It is the one refusal in this client that means "go to a screen", not "you
 * may not": an account that holds the operator custody and has no app code
 * gets a session good for `/credentials/*` alone, and the only way out is the
 * enrolment that route serves. Matched on the status **and** the sentence,
 * because 403 alone is also `not authorised`, which means the opposite.
 */
export const TOTP_REQUIRED_SENTENCE = 'enrol an app code first';

export function isTotpRequired(error: unknown): boolean {
  return (
    error instanceof ApiRefusal &&
    error.status === 403 &&
    error.message.toLowerCase().includes(TOTP_REQUIRED_SENTENCE)
  );
}

/**
 * Is the live session a **setup session** — good for `/credentials/*` and
 * refused everywhere else?
 *
 * There is nothing in `POST /session`'s answer that says so: the refusal is
 * what says it, and it arrives on the first ordinary route the session
 * touches. So this asks one ordinary route on purpose, right after sign-in,
 * rather than letting the refusal surface out of whichever screen happened to
 * fetch first. `GET /organisations` is the one the account plane opens with
 * anyway, so the probe costs a request the next screen would have made.
 *
 * `true` means "take this person to the app-code enrolment". Any other
 * outcome, refusal or not, is `false`: a probe is not a place to invent a
 * verdict about a session that answered something else entirely.
 */
export async function appCodeEnrolmentRequired(): Promise<boolean> {
  try {
    await signedFetch('GET', '/organisations');
    return false;
  } catch (error) {
    return isTotpRequired(error);
  }
}

/**
 * Six digits is an app code; anything else the server tries as a backup code
 * (`sessions.rs`'s `check_second_factor`). This client does not decide which
 * it is — it is stated here only so the sign-in screen can say so in plain
 * words on the one field that takes both.
 */
export function looksLikeAppCode(code: string): boolean {
  return /^[0-9]{6}$/.test(code.trim());
}

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

/** `POST /enrolment/operator/setup` — spend the token file's token and set the
 * first operator's password. Answers nothing: the client signs in afterwards
 * (the lead's resolution 4), which is one more round trip and one fewer way
 * for a token to become a session without the password being checked. */
export async function redeemOperatorSetup(token: Uint8Array, password: string): Promise<void> {
  await unsigned('/enrolment/operator/setup', buildTokenAndPasswordBody(token, password));
}

/** `POST /credentials/password` — set or change this session's own password. */
export async function setPassword(password: string): Promise<void> {
  await signedFetch('POST', '/credentials/password', buildPasswordBody(password));
}

/** `POST /credentials/totp/enrol` — draw a secret. One per session. */
export async function enrolAppCode(): Promise<TotpEnrolment> {
  return parseTotpEnrolment(await signedFetch('POST', '/credentials/totp/enrol', EMPTY));
}

/** `POST /credentials/totp/confirm` — prove the code works and take the backup
 * codes. They are shown **once**: the server keeps only their hashes. */
export async function confirmAppCode(code: string): Promise<string[]> {
  return parseBackupCodes(await signedFetch('POST', '/credentials/totp/confirm', buildAppCodeBody(code)));
}

/**
 * Generate this browser's long-term account key, register its public half, and
 * store the pair under `address` so the next sign-in can present it as
 * evidence (`./auth.ts`'s `findKey`).
 *
 * The private half is generated non-extractable and never leaves this browser
 * (`../crypto/keys.ts`). It is written to the enrolled slot only after the
 * server's answer has been read as a definite OK, the same discipline
 * `./enrolment.ts` follows with an invitation — a key the server never
 * recorded would cost the next sign-in one refused signature.
 */
export async function registerBrowserKey(address: string): Promise<string> {
  const pair = await generateKeyPair();
  const publicKey = await exportPublicKeyRaw(pair.publicKey);
  const keyId = parseKeyId(await signedFetch('POST', '/credentials/key', buildPublicKeyBody(publicKey)));
  await putEnrolledKeyPair(address, pair);
  return keyId;
}

/**
 * `POST /credentials/reset` — *"forgot my password"*.
 *
 * **Answers 200 for every address**, known or not (ADR-0055 decision 7, OWASP
 * ASVS 6.3.8 as the ADR read it), so this function resolving says nothing
 * about whether an account exists and the screen above it must not suggest it
 * does. A refusal here is a rate limit, which answers the same way for every
 * address.
 */
export async function requestReset(address: string): Promise<void> {
  await unsigned('/credentials/reset', buildAddressBody(address));
}

/** `POST /credentials/reset/redeem` — spend a reset token and set a password.
 * No session comes back: decision 7's *"no automatic sign-in"*. */
export async function redeemReset(token: Uint8Array, password: string): Promise<void> {
  await unsigned('/credentials/reset/redeem', buildTokenAndPasswordBody(token, password));
}

async function unsigned(path: string, body: Uint8Array): Promise<Uint8Array> {
  const response = await fetch(path, { method: 'POST', body: body as BodyInit });
  if (!response.ok) {
    throw await refusalFrom(response);
  }
  return new Uint8Array(await response.arrayBuffer());
}

// ---------------------------------------------------------------------------
// PROVISIONAL — the seam to ADR-0055 client streams (b) and (c)
// ---------------------------------------------------------------------------
//
// **These two are built here only so this stream can be driven end to end**,
// and they are meant to be deleted at the merge. Stream (c) owns
// `client/src/api/placement.ts` and ships `useConsoleHost()`; stream (b) owns
// the operator plane and ships the bootstrap. `App.tsx`'s one labelled block
// names both imports; swapping them over is a two-line edit in that block and
// a deletion of this section.
//
// Nothing else in this client imports them.

/** `GET /placement/flag`, unauthenticated, outside `/admin` on purpose: on a
 * host that is not the console host, `/admin` is answered 404, and `"no"` is
 * exactly the answer this client needs there. */
export async function fetchConsoleHostFlag(): Promise<{ consoleHost: boolean; confirmBy: number | null }> {
  const response = await fetch('/placement/flag', { method: 'GET' });
  if (!response.ok) {
    throw await refusalFrom(response);
  }
  return parsePlacementFlag(new Uint8Array(await response.arrayBuffer()));
}

/**
 * `POST /admin/operators/self/key` — this account's browser registers its
 * operator key, from the ACCOUNT session, and learns which operator the
 * custody is bound to.
 *
 * Refused (403) for an account that holds no operator custody, which is the
 * ordinary case and is not an error: the caller shows nothing operator-side.
 */
export async function registerOperatorKey(publicKey: Uint8Array): Promise<{ keyId: string; operatorId: string }> {
  return parseOperatorKeyAnswer(
    await signedFetch('POST', '/admin/operators/self/key', buildPublicKeyBody(publicKey)),
  );
}
