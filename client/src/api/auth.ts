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
import { PRINCIPAL_KIND_STEWARD } from './constants';
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

  constructor(address: string) {
    super(`No account key found in this browser for ${address}.`);
    this.name = 'NoEnrolledKeyError';
    this.address = address;
  }
}

/**
 * Sign in as a steward at `address`.
 *
 * Generates a fresh, non-extractable session keypair; asks the server for a
 * challenge bound to its public half; signs that challenge with the
 * address's account key; and exchanges the result for a session.
 *
 * Uses the enrolled key if this browser has one. If it does not, it falls
 * back to a PENDING key for the address (`../crypto/keys.ts`) -- the state
 * left behind when `redeemAccountEnrolment` could not confirm the server's
 * answer (see its doc comment and `../../docs/OPEN-QUESTIONS.md` D12). A
 * pending key the server never actually enrolled costs exactly one refused
 * sign-in here and nothing else; a pending key the server did enrol lets
 * this call succeed, and success promotes it to the enrolled slot so the
 * next sign-in does not need this fallback.
 *
 * Throws [`NoEnrolledKeyError`] before any network call if this browser
 * holds neither, and an [`ApiRefusal`](./errors.ts) — the server's own
 * uniform wording, unchanged — for every refusal the server itself can
 * produce.
 */
export async function signIn(address: string): Promise<void> {
  let enrolledKeyPair = await getEnrolledKeyPair(address);
  let usingPendingKey = false;
  if (!enrolledKeyPair) {
    enrolledKeyPair = await getPendingKeyPair(address);
    if (!enrolledKeyPair) {
      throw new NoEnrolledKeyError(address);
    }
    usingPendingKey = true;
  }

  const sessionKeyPair = await generateKeyPair();
  const sessionPubkey = await exportPublicKeyRaw(sessionKeyPair.publicKey);

  // Body: LP(principal_kind) || LP(address) || LP(session_pubkey)
  const challengeBody = concatBytes(
    lp(utf8(PRINCIPAL_KIND_STEWARD)),
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
    lp(utf8(PRINCIPAL_KIND_STEWARD)),
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
  // Answer: LP(session_id) || LP(token) || u64(expires_at_unix)
  const signInOut = new Uint8Array(await signInResponse.arrayBuffer());
  const { value: sessionIdBytes, rest: afterSessionId } = readLp(signInOut);
  const { value: token, rest: afterToken } = readLp(afterSessionId);
  const expiresAtUnix = Number(readU64LE(afterToken));

  if (usingPendingKey) {
    // The server just accepted a signature made with the pending key, so it
    // was enrolled after all -- move it to the enrolled slot. Best effort:
    // if this local write fails, the pending key is simply tried again next
    // time, at the cost of nothing beyond repeating this promotion.
    await promotePendingKeyPair(address).catch(() => {});
  }

  setSession({
    sessionId: new TextDecoder().decode(sessionIdBytes),
    token,
    sessionKeyPair,
    expiresAtUnix,
    address,
  });
}

/** `DELETE /session`, signed like every other protected route. */
export async function signOut(): Promise<void> {
  await signedFetch('DELETE', '/session');
  setSession(null);
}
