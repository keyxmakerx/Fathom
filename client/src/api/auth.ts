// The sign-in flow: `POST /session/challenge`, then `POST /session`.
// `crates/fathom-server/src/api.rs`'s doc comments on `challenge_handler`
// and `sign_in_handler` give the exact body and answer shapes; this module
// assembles and reads exactly those bytes and nothing else.

import { concatBytes, lp, readLp, readU64LE, utf8 } from '../crypto/bytes';
import { exportPublicKeyRaw, generateSessionKeyPair, getEnrolledKeyPair, signMessage } from '../crypto/keys';
import { sessionChallenge } from '../crypto/session';
import { setSession } from '../state/sessionState';
import { PRINCIPAL_KIND_STEWARD } from './constants';
import { refusalFrom } from './errors';
import { signedFetch } from './signedFetch';

/**
 * Thrown when this browser holds no enrolled key for the given address.
 *
 * **This build has no enrolment surface.** Enrolment is by invitation
 * through an admin console `docs/REBUILD-PLAN.md` Phase 2 has not built, so
 * this is the ordinary case for every address today, not a bug in this
 * screen. `SignIn.tsx` shows the message on this error and nothing more —
 * inventing a reason beyond "this browser does not have it" would be a
 * guess this client has no way to stand behind.
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
 * address's already-enrolled account key; and exchanges the result for a
 * session. Throws [`NoEnrolledKeyError`] before any network call if this
 * browser holds no such key, and an [`ApiRefusal`](./errors.ts) — the
 * server's own uniform wording, unchanged — for every refusal the server
 * itself can produce.
 */
export async function signIn(address: string): Promise<void> {
  const enrolledKeyPair = await getEnrolledKeyPair(address);
  if (!enrolledKeyPair) {
    throw new NoEnrolledKeyError(address);
  }

  const sessionKeyPair = await generateSessionKeyPair();
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
