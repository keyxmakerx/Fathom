// The sign-in flow: `POST /session/challenge`, then `POST /session`.
// `crates/fathom-server/src/api.rs`'s doc comments on `challenge_handler`
// and `sign_in_handler` give the exact body and answer shapes; this module
// assembles and reads exactly those bytes and nothing else.

import { concatBytes, lp, readLp, readU64LE, utf8 } from '../crypto/bytes';
import {
  exportPublicKeyRaw,
  generateKeyPair,
  getEnrolledKeyPair,
  getPendingKeyPair,
  promotePendingKeyPair,
  signMessage,
} from '../crypto/keys';
import { sessionChallenge } from '../crypto/session';
import { heldSessions, setSession } from '../state/sessionState';
import {
  keySlot,
  looksLikeOperatorId,
  OPERATOR_PENDING_SLOT,
  PRINCIPAL_KIND_OPERATOR,
  PRINCIPAL_KIND_STEWARD,
  type PrincipalKind,
} from './constants';
import { registerBrowserKey } from './credentials';
import { ApiRefusal, refusalFrom } from './errors';
import { signedFetchOn } from './signedFetch';

/**
 * Thrown when this browser holds no enrolled key -- and no pending one
 * either -- for the given address.
 *
 * Enrolment is by invitation, through `./enrolment.ts`'s
 * `redeemAccountEnrolment` (`Enrol.tsx`). Before that has ever happened for
 * an address, or after this browser's storage has genuinely lost both
 * copies, this is the honest state, not a bug in this screen. `SignIn.tsx`
 * shows the message on this error and nothing more — inventing a reason
 * beyond "this browser does not have it" would be a guess this client has
 * no way to stand behind.
 */
export class NoEnrolledKeyError extends Error {
  readonly address: string;

  constructor(address: string, kind: PrincipalKind = PRINCIPAL_KIND_STEWARD) {
    super(
      kind === PRINCIPAL_KIND_OPERATOR
        ? `No operator key found in this browser for operator ${address}.`
        : `No account key found in this browser for ${address}.`,
    );
    this.name = 'NoEnrolledKeyError';
    this.address = address;
  }
}

/**
 * `SessionError::SecondFactorNeeded`, as it arrives: **401** and the sentence
 * `api.rs` fixes for it, `second factor needed`.
 *
 * ADR-0056 decision 3: the address and the password verified, the account
 * holds a confirmed authenticator, and no code came with them. It is the one
 * 401 on this route that means "ask for the code", not "you may not": no
 * session was issued, nothing was spent, and the sealed entry records it as a
 * refusal with its own reason. Matched on the status **and** the sentence,
 * because 401 alone is the uniform sign-in refusal, which means the opposite
 * and must never route anywhere.
 */
export const SECOND_FACTOR_NEEDED_SENTENCE = 'second factor needed';

export function isSecondFactorNeeded(error: unknown): boolean {
  return (
    error instanceof ApiRefusal &&
    error.status === 401 &&
    error.message.trim().toLowerCase().startsWith(SECOND_FACTOR_NEEDED_SENTENCE)
  );
}

/**
 * Sign in as a steward at `address`, or -- `kind` `'operator'` -- as the
 * operator whose id `address` is (`./constants.ts`: the operator plane's
 * address is the operator id).
 *
 * **`kind` omitted means: whichever plane this browser holds a key for.**
 * Nobody chooses a plane on the sign-in screen (the owner's rule,
 * 2026-09-21: *"if they have access they have access, it shouldn't be a
 * selection"*). The key is the access, and it was filed under one plane's
 * slot when it was enrolled, so the slot decides: the account slots for
 * `address` are tried first, then the operator slots, then -- only when
 * `address` has an operator id's shape -- the sentinel slot an operator's
 * key waits in before its owner was named. No network call is made until a
 * key is found, so a wrong guess costs nothing and the server is never
 * asked about a plane the browser has no key for.
 *
 * Generates a fresh, non-extractable session keypair; asks the server for a
 * challenge bound to its public half; signs that challenge with the
 * principal's enrolled key; and exchanges the result for a session.
 *
 * Uses the enrolled key if this browser has one. If it does not, it falls
 * back to a PENDING key for the address (`../crypto/keys.ts`) -- the state
 * left behind when `redeemAccountEnrolment` could not confirm the server's
 * answer (see its doc comment and `../../docs/OPEN-QUESTIONS.md` D12). A
 * pending key the server never actually enrolled costs exactly one refused
 * sign-in here and nothing else; a pending key the server did enrol lets
 * this call succeed, and success promotes it to the enrolled slot so the
 * next sign-in does not need this fallback. An operator has one more place
 * to look: `OPERATOR_PENDING_SLOT`, where `redeemOperatorEnrolment` leaves
 * a key whose owner the server never got to say.
 *
 * Throws [`NoEnrolledKeyError`] before any network call if this browser
 * holds neither **and no password was typed**, and an
 * [`ApiRefusal`](./errors.ts) — the server's own uniform wording, unchanged —
 * for every refusal the server itself can produce.
 *
 * **Since ADR-0055 decision 6 a key is no longer required at all.** The
 * address, a password and a verification code sign in from any browser, with no
 * pairing; a key this browser happens to hold is sent beside them as evidence
 * and is what makes the session `A1`. `credential` carries the other two
 * fields; both go on the wire empty when there is nothing to put in them,
 * because `POST /session` takes exactly six fields.
 */
export async function signIn(
  address: string,
  kind?: PrincipalKind,
  credential: SignInCredential = {},
): Promise<void> {
  const password = credential.password ?? '';
  const verificationCode = credential.verificationCode ?? '';
  const found = await findKey(address, kind);
  if (!found && password.length === 0) {
    throw new NoEnrolledKeyError(address, kind ?? (looksLikeOperatorId(address) ? PRINCIPAL_KIND_OPERATOR : PRINCIPAL_KIND_STEWARD));
  }
  // A password is the account plane's credential and only the account
  // plane's: `sessions.rs` reads `accounts.password_hash`, and an operator
  // principal has no account row of its own (ADR-0055 decision 1 binds the
  // custody to an account; the operator still signs in by key). So a
  // password with no key found means the steward plane, unless the caller
  // named one.
  kind = found ? found.kind : (kind ?? PRINCIPAL_KIND_STEWARD);
  const slot = keySlot(kind, address);
  const enrolledKeyPair = found?.pair ?? null;
  // Which pending slot the key came from, if any, so success can promote
  // exactly that one into `slot`.
  const pendingSlot = found?.pendingSlot ?? null;

  const sessionKeyPair = await generateKeyPair();
  const sessionPubkey = await exportPublicKeyRaw(sessionKeyPair.publicKey);

  // Body: LP(principal_kind) || LP(address) || LP(session_pubkey)
  const challengeBody = concatBytes(
    lp(utf8(kind)),
    lp(utf8(address)),
    lp(sessionPubkey),
  );
  const challengeResponse = await fetch('/session/challenge', {
    method: 'POST',
    body: challengeBody as BodyInit,
  });
  if (!challengeResponse.ok) {
    throw await refusalFrom(challengeResponse);
  }
  // Answer: LP(nonce) || LP(deployment_id)
  const challengeOut = new Uint8Array(await challengeResponse.arrayBuffer());
  const { value: serverNonce, rest } = readLp(challengeOut);
  const { value: deploymentIdBytes } = readLp(rest);
  const deploymentId = new TextDecoder().decode(deploymentIdBytes);

  const challenge = await sessionChallenge(sessionPubkey, serverNonce, deploymentId);
  // No key in this browser is an ordinary state since ADR-0055 decision 6
  // ("any browser, no pairing"): the evidence field goes empty and the
  // password and the verification code are what the server checks. A key, when this
  // browser has one, still signs the challenge and still buys `A1`.
  const evidenceSig = enrolledKeyPair
    ? await signMessage(enrolledKeyPair.privateKey, challenge)
    : new Uint8Array(0);

  const signInBody = buildSignInBody(kind, sessionPubkey, serverNonce, evidenceSig, password, verificationCode);
  const signInResponse = await fetch('/session', {
    method: 'POST',
    body: signInBody as BodyInit,
  });
  if (!signInResponse.ok) {
    throw await refusalFrom(signInResponse);
  }
  const { sessionId, token, expiresAtUnix, accountId } = parseSignInAnswer(
    new Uint8Array(await signInResponse.arrayBuffer()),
  );

  if (pendingSlot !== null) {
    // The server just accepted a signature made with the pending key, so it
    // was enrolled after all -- move it to the enrolled slot. Best effort:
    // if this local write fails, the pending key is simply tried again next
    // time, at the cost of nothing beyond repeating this promotion.
    await promotePendingKeyPair(pendingSlot, slot).catch(() => {});
  }

  setSession({
    sessionId,
    kind,
    token,
    sessionKeyPair,
    expiresAtUnix,
    address,
    accountId,
  });

  // **This browser's own key, registered silently once there is a session to
  // register it under** (ADR-0055 decision 6: the browser is not paired, it
  // simply keeps a key so the next sign-in is `A1`). Best effort: a failure
  // here costs the next sign-in its `A1` and nothing else, so it must never
  // undo a sign-in that has already succeeded.
  //
  // **Only when a verification code was presented**, and the reason is a
  // property of the server this client must not walk into: `sessions.rs` (4)
  // gives `A1` to password + key even when no second factor is enrolled yet,
  // and the setup gate in `verify_inside` fires on `A0` alone. Registering a
  // key for an operator-custody account that has not finished enrolling its
  // authenticator would therefore turn its next session from a setup session
  // into a full one. A code in hand means the account is past that point.
  // `FirstRun.tsx` passes `registerBrowserKey: false` for the sign-in it
  // makes mid-flow, before the authenticator exists.
  if (
    credential.registerBrowserKey !== false &&
    kind === PRINCIPAL_KIND_STEWARD &&
    found === null &&
    verificationCode.trim().length > 0
  ) {
    await registerBrowserKey(address).catch(() => {});
  }
}

/** What the person typed at the door, beside their address. */
export interface SignInCredential {
  /** The password. Empty for the key-only path, which is every operator
   * sign-in and every account that has never set one. */
  password?: string;
  /** Six digits from the authenticator app, or one of the ten recovery
   * codes — the server tries the second when the first does not fit
   * (`sessions.rs`'s `check_second_factor`), which is why the screen has one
   * field. Named for what a person is asked for (ADR-0056 decision 4); the
   * wire field and the server's own identifiers are unchanged. */
  verificationCode?: string;
  /** Register a key for this browser on success when it holds none. Default
   * true; `FirstRun.tsx` passes `false` for the sign-in it makes mid-flow,
   * before the authenticator exists. */
  registerBrowserKey?: boolean;
}

/**
 * `POST /session`'s body: `LP(kind) ‖ LP(session_pubkey) ‖ LP(nonce) ‖
 * LP(evidence_sig) ‖ LP(password) ‖ LP(code)`. The sixth field is the
 * server's `app_code` — a wire name, unchanged by ADR-0056 decision 4, which
 * renames what a person reads and not what a route is called.
 *
 * Six fields since ADR-0055 decision 10 widened the route, and `api.rs`'s
 * `read_fields` refuses an inexact count — so the last two are sent on every
 * path, empty where there is nothing to put in them. Exported so
 * `auth.test.ts` can check the framing without a network call.
 */
export function buildSignInBody(
  kind: PrincipalKind,
  sessionPubkey: Uint8Array,
  nonce: Uint8Array,
  evidenceSig: Uint8Array,
  password: string,
  verificationCode: string,
): Uint8Array {
  return concatBytes(
    lp(utf8(kind)),
    lp(sessionPubkey),
    lp(nonce),
    lp(evidenceSig),
    lp(utf8(password)),
    lp(utf8(verificationCode.trim())),
  );
}

interface FoundKey {
  kind: PrincipalKind;
  pair: CryptoKeyPair;
  /** The pending slot the pair was read from, or `null` for an enrolled one. */
  pendingSlot: string | null;
}

/** The key this browser holds for `address` on `kind`'s plane, or on
 * whichever plane has one when `kind` is not given -- see `signIn`. */
async function findKey(address: string, kind: PrincipalKind | undefined): Promise<FoundKey | null> {
  const kinds: PrincipalKind[] = kind ? [kind] : [PRINCIPAL_KIND_STEWARD, PRINCIPAL_KIND_OPERATOR];
  for (const candidate of kinds) {
    const slot = keySlot(candidate, address);
    const enrolled = await getEnrolledKeyPair(slot);
    if (enrolled) {
      return { kind: candidate, pair: enrolled, pendingSlot: null };
    }
    const pending = await getPendingKeyPair(slot);
    if (pending) {
      return { kind: candidate, pair: pending, pendingSlot: slot };
    }
  }
  // The operator sentinel: a key enrolled for an operator the answer never
  // named. Only worth trying for something shaped like an operator id, and
  // only when the operator plane is in question at all.
  if ((kind === undefined || kind === PRINCIPAL_KIND_OPERATOR) && looksLikeOperatorId(address)) {
    const waiting = await getPendingKeyPair(OPERATOR_PENDING_SLOT);
    if (waiting) {
      return { kind: PRINCIPAL_KIND_OPERATOR, pair: waiting, pendingSlot: OPERATOR_PENDING_SLOT };
    }
  }
  return null;
}

/**
 * Parses `POST /session`'s answer: `LP(session_id) || LP(token) ||
 * u64(expires_at_unix) || LP(account_id)`.
 *
 * ADR-0053 §3: `account_id` is appended after the three fields this client
 * already read, so it can be added without breaking a client built before
 * this change. `account_id` is the signed-in principal's ulid, and this
 * client stamps it as the actor on every change it makes from here on
 * (`useDesignSession.ts`).
 *
 * Exported for `auth.test.ts`, which drives it directly rather than through
 * a stubbed `fetch` and the rest of `signIn`'s IndexedDB machinery.
 */
export function parseSignInAnswer(bytes: Uint8Array): {
  sessionId: string;
  token: Uint8Array;
  expiresAtUnix: number;
  accountId: string;
} {
  const { value: sessionIdBytes, rest: afterSessionId } = readLp(bytes);
  const { value: token, rest: afterToken } = readLp(afterSessionId);
  const expiresAtUnix = Number(readU64LE(afterToken));
  const { value: accountIdBytes } = readLp(afterToken.slice(8));
  return {
    sessionId: new TextDecoder().decode(sessionIdBytes),
    token,
    expiresAtUnix,
    accountId: new TextDecoder().decode(accountIdBytes),
  };
}

/**
 * `DELETE /session`, signed like every other protected route -- **once per
 * session this browser holds**.
 *
 * Since ADR-0055 decision 1 the browser can hold two, the account's and the
 * operator's (`../state/sessionState.ts`). Signing out signs the person out,
 * not the custody they happen to be looking at, so each live session is
 * ended on its own plane with its own key and its own counter. Every attempt
 * is made even if an earlier one fails: a session row this browser could not
 * reach expires on its own, and forgetting it here while leaving the other
 * one live would be the worse of the two outcomes.
 */
export async function signOut(): Promise<void> {
  const held = heldSessions();
  const results = await Promise.allSettled(
    held.map(({ plane }) => signedFetchOn(plane, 'DELETE', '/session')),
  );
  setSession(null);
  const failed = results.find((r) => r.status === 'rejected');
  if (failed && failed.status === 'rejected') {
    throw failed.reason;
  }
}
