// The credential plane: the routes a person uses to set a password, set up an
// authenticator app, take their recovery codes, register this browser's key,
// and ask for a reset. (The route names and the server's own identifiers keep
// `totp` and `backup_code`: ADR-0056 decision 4 renames what a person reads,
// not what is routed or stored.) ADR-0055 decision 10, built server-side by
// stream (a) and spelled byte for byte in
// `crates/fathom-server/src/api.rs`'s `credential_router` block.
//
// **Every body and every answer here is length-prefixed**, the framing
// `../crypto/bytes.ts` carries and `crypto::read_lp` reads. The routes, as the
// server has them on 2026-09-21:
//
// | Route | Signed | Body | Answer |
// |---|---|---|---|
// | `POST /enrolment/operator/setup` | no | `LP(token) ‖ LP(password)` | empty |
// | `POST /credentials/password` | yes | `LP(current_password) ‖ LP(password) ‖ LP(session_pubkey) ‖ LP(nonce) ‖ LP(evidence_sig)` | empty |
// | `GET /credentials/status` | yes | empty | `LP("yes"\|"no")` |
// | `POST /credentials/totp/enrol` | yes | `LP(current_password) ‖ LP(code)` | `LP(otpauth_uri) ‖ LP(secret)` |
// | `POST /credentials/totp/confirm` | yes | `LP(app_code)` | ten `LP(backup_code)` |
// | `POST /credentials/key` | yes | `LP(public_key)` | `LP(key_id)` |
// | `POST /credentials/reset` | no | `LP(address)` | empty, always |
// | `POST /credentials/reset/redeem` | no | `LP(token) ‖ LP(password)` | empty |
//
// ADR-0057 decisions 2 and 3: the current password (once one is set) is
// required to change the password, and the current password plus a current
// code is required to replace a confirmed authenticator — both empty for
// the one exception each has (the first-run setup session; a first
// enrolment).
//
// The setup and reset routes are unauthenticated by construction — there is no
// session to sign with yet — so they go through plain `fetch` and
// `refusalFrom`, exactly as `./auth.ts`'s challenge and sign-in do. Everything
// else goes through `./signedFetch.ts`, which is the only way this client
// reaches a route that composes `Signed`.

import { concatBytes, lp, readLp, utf8 } from '../crypto/bytes';
import {
  exportPublicKeyRaw,
  generateKeyPair,
  getEnrolledKeyPair,
  putEnrolledKeyPair,
  signMessage,
} from '../crypto/keys';
import { sessionChallenge } from '../crypto/session';
import { PRINCIPAL_KIND_STEWARD } from './constants';
import { ApiRefusal, refusalFrom } from './errors';
import { signedFetch } from './signedFetch';

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

/**
 * `LP(current) ‖ LP(new) ‖ LP(session_pubkey) ‖ LP(nonce) ‖ LP(evidence_sig)`
 * — the last three are [`freshEvidence`]'s, non-empty only with no current password.
 */
export function buildPasswordBody(
  currentPassword: string,
  password: string,
  evidence: FreshEvidence | null,
): Uint8Array {
  return concatBytes(
    lp(utf8(currentPassword)),
    lp(utf8(password)),
    lp(evidence?.sessionPubkey ?? new Uint8Array(0)),
    lp(evidence?.nonce ?? new Uint8Array(0)),
    lp(evidence?.evidenceSig ?? new Uint8Array(0)),
  );
}

/** What [`freshEvidence`] gathers, and [`buildPasswordBody`] sends. */
interface FreshEvidence {
  readonly sessionPubkey: Uint8Array;
  readonly nonce: Uint8Array;
  readonly evidenceSig: Uint8Array;
}

/**
 * A fresh signature by this browser's own enrolled key over a bind-purpose
 * challenge; `null` when this browser holds no enrolled key for `address`.
 */
async function freshEvidence(address: string): Promise<FreshEvidence | null> {
  const enrolledKeyPair = await getEnrolledKeyPair(address);
  if (!enrolledKeyPair) return null;

  const sessionKeyPair = await generateKeyPair();
  const sessionPubkey = await exportPublicKeyRaw(sessionKeyPair.publicKey);
  const challengeBody = concatBytes(lp(utf8(PRINCIPAL_KIND_STEWARD)), lp(utf8(address)), lp(sessionPubkey));
  const challengeResponse = await fetch('/session/challenge', {
    method: 'POST',
    body: challengeBody as BodyInit,
  });
  if (!challengeResponse.ok) {
    throw await refusalFrom(challengeResponse);
  }
  const challengeOut = new Uint8Array(await challengeResponse.arrayBuffer());
  const { value: nonce, rest } = readLp(challengeOut);
  const { value: deploymentIdBytes } = readLp(rest);
  const deploymentId = new TextDecoder().decode(deploymentIdBytes);

  const challenge = await sessionChallenge(sessionPubkey, nonce, deploymentId);
  const evidenceSig = await signMessage(enrolledKeyPair.privateKey, challenge);
  return { sessionPubkey, nonce, evidenceSig };
}

/** `LP(current_password) ‖ LP(code)` — `POST /credentials/totp/enrol`
 * (ADR-0057 decision 3). Both empty for a first enrolment; non-empty and
 * checked when the account already has a confirmed authenticator —
 * `currentPassword` only when one is set on the account, `code` always, a
 * current one from the authenticator being replaced. */
export function buildReauthBody(currentPassword: string, code: string): Uint8Array {
  return concatBytes(lp(utf8(currentPassword)), lp(utf8(code.trim())));
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
  /** `otpauth://totp/...`. ADR-0056 decision 5: the enrolment screen draws
   * this as a QR code, in the page, from `../qr` — a password manager reads
   * the secret only out of a picture. The URI itself stays on the screen
   * behind a disclosure for whoever wants the link. */
  otpauthUri: string;
  /** RFC 4648 base32 — the **setup key**, for typing in by hand. */
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
 * The recovery codes: one `LP(code)` after another until the body runs out.
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

// ---------------------------------------------------------------------------
// The refusal that is a route, not a wall
// ---------------------------------------------------------------------------

/**
 * `SessionError::TotpRequired`, as it arrives: **403** and the sentence
 * `api.rs` fixes for it, `set up an authenticator first`.
 *
 * It is the one refusal in this client that means "go to a screen", not "you
 * may not": an account that holds the operator custody and has no confirmed
 * authenticator gets a session good for `/credentials/*` alone, and the only
 * way out is the enrolment that route serves. Matched on the status **and**
 * the sentence, because 403 alone is also `not authorised`, which means the
 * opposite.
 *
 * **Both sentences are matched, on purpose.** ADR-0056 decision 4 moves the
 * vocabulary, and this sentence moved with it on 2026-09-22 — but a
 * deployment restarts its halves one at a time, so for the length of one
 * restart a client from this build can be talking to a server from the last
 * one. A client that recognised only the new wording would answer that
 * server's "go to the enrolment screen" with a dead end. The old sentence is
 * matched until a build after the servers have all moved; deleting it is a
 * one-line change and this comment is the note that it is owed.
 */
export const TOTP_REQUIRED_SENTENCE = 'set up an authenticator first';

/** The same refusal as a server from before 2026-09-22 words it. Matched, not
 * shown: no screen in this client prints either sentence. */
export const TOTP_REQUIRED_SENTENCE_BEFORE_ADR_0056 = 'enrol an app code first';

export function isTotpRequired(error: unknown): boolean {
  if (!(error instanceof ApiRefusal) || error.status !== 403) return false;
  const said = error.message.toLowerCase();
  return (
    said.includes(TOTP_REQUIRED_SENTENCE) ||
    said.includes(TOTP_REQUIRED_SENTENCE_BEFORE_ADR_0056)
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
 * Six digits is a verification code; anything else the server tries as a
 * recovery code
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

/** `POST /enrolment/operator/setup` — spend the setup secret (ADR-0057
 * decision 1: a recovery code, or this start's setup password) and set the
 * first operator's password. Answers nothing: the client signs in
 * afterwards, one fewer way for a token to become a session without the
 * password being checked. */
export async function redeemOperatorSetup(secret: Uint8Array, password: string): Promise<void> {
  await unsigned('/enrolment/operator/setup', buildTokenAndPasswordBody(secret, password));
}

/**
 * `POST /credentials/password`. `currentPassword` required once set; `''`
 * gathers `address`'s fresh evidence instead (the account's first password).
 */
export async function setPassword(address: string, currentPassword: string, password: string): Promise<void> {
  const evidence = currentPassword === '' ? await freshEvidence(address) : null;
  await signedFetch('POST', '/credentials/password', buildPasswordBody(currentPassword, password, evidence));
}

/** `GET /credentials/status` — does this session's account have a
 * confirmed authenticator? ADR-0057 decision 3: the account screen's own
 * question. */
export async function hasAuthenticator(): Promise<boolean> {
  const answer = await signedFetch('GET', '/credentials/status');
  const { value } = readLp(answer);
  return decoder.decode(value) === 'yes';
}

/** `POST /credentials/totp/enrol` — draw a secret. A first enrolment needs
 * nothing beyond the session; replacing a confirmed authenticator needs the
 * current password and a current code from the one being replaced
 * (ADR-0057 decision 3, ASVS 7.5.1). */
export async function enrolAppCode(currentPassword = '', code = ''): Promise<TotpEnrolment> {
  return parseTotpEnrolment(
    await signedFetch('POST', '/credentials/totp/enrol', buildReauthBody(currentPassword, code)),
  );
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
