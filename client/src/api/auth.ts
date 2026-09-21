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
import { setSession } from '../state/sessionState';
import {
  keySlot,
  looksLikeOperatorId,
  OPERATOR_PENDING_SLOT,
  PRINCIPAL_KIND_OPERATOR,
  PRINCIPAL_KIND_STEWARD,
  type PrincipalKind,
} from './constants';
import { refusalFrom } from './errors';
import { signedFetch } from './signedFetch';

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
 * holds neither, and an [`ApiRefusal`](./errors.ts) — the server's own
 * uniform wording, unchanged — for every refusal the server itself can
 * produce.
 */
export async function signIn(address: string, kind?: PrincipalKind): Promise<void> {
  const found = await findKey(address, kind);
  if (!found) {
    throw new NoEnrolledKeyError(address, kind ?? (looksLikeOperatorId(address) ? PRINCIPAL_KIND_OPERATOR : PRINCIPAL_KIND_STEWARD));
  }
  kind = found.kind;
  const slot = keySlot(kind, address);
  const enrolledKeyPair = found.pair;
  // Which pending slot the key came from, if any, so success can promote
  // exactly that one into `slot`.
  const pendingSlot = found.pendingSlot;

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
  const evidenceSig = await signMessage(enrolledKeyPair.privateKey, challenge);

  // Body: LP(principal_kind) || LP(session_pubkey) || LP(nonce) || LP(evidence_sig)
  const signInBody = concatBytes(
    lp(utf8(kind)),
    lp(sessionPubkey),
    lp(serverNonce),
    lp(evidenceSig),
  );
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

/** `DELETE /session`, signed like every other protected route. */
export async function signOut(): Promise<void> {
  await signedFetch('DELETE', '/session');
  setSession(null);
}
