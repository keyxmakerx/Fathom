// The two byte constructions `crates/fathom-server/src/sessions.rs` signs
// and verifies against. Assembled independently here, from the same
// doc comments and constant block that file carries (the `TAG_*` block near
// its top), not by calling into any generated artefact -- see
// `session.test.ts` for why that independence is the point.

import { concatBytes, lp, u64LE, utf8 } from './bytes';

const TAG_SESSION_BIND = utf8('fathom/session/bind/v1');
const TAG_SESSION_REQUEST = utf8('fathom/session/req/v1');

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return new Uint8Array(digest);
}

/**
 * `sessions::session_challenge`:
 * `H(LP("fathom/session/bind/v1") || LP(session_pubkey) || LP(server_nonce) || LP(deployment_id))`.
 */
export async function sessionChallenge(
  sessionPubkey: Uint8Array,
  serverNonce: Uint8Array,
  deploymentId: string,
): Promise<Uint8Array> {
  const message = concatBytes(
    lp(TAG_SESSION_BIND),
    lp(sessionPubkey),
    lp(serverNonce),
    lp(utf8(deploymentId)),
  );
  return sha256(message);
}

/**
 * `sessions::request_bytes`:
 * `LP("fathom/session/req/v1") || LP(session_id) || LP(method) || LP(path)
 *   || LP(H(body)) || LP(nonce) || u64_le(unix_ms) || u64_le(request_counter)`.
 *
 * The nonce sits inside the signed bytes -- `sessions.rs`'s own doc comment
 * calls this out as a departure from the design document and the reason a
 * captured, replayed request cannot be re-presented under a fresh nonce.
 */
export function requestBytes(
  sessionId: string,
  method: string,
  path: string,
  bodyDigestBytes: Uint8Array,
  nonce: Uint8Array,
  unixMs: number,
  requestCounter: number,
): Uint8Array {
  return concatBytes(
    lp(TAG_SESSION_REQUEST),
    lp(utf8(sessionId)),
    lp(utf8(method)),
    lp(utf8(path)),
    lp(bodyDigestBytes),
    lp(nonce),
    u64LE(unixMs),
    u64LE(requestCounter),
  );
}

/** `sessions::body_digest`: `SHA-256(body)`, no length prefix. */
export async function bodyDigest(body: Uint8Array): Promise<Uint8Array> {
  return sha256(body);
}
