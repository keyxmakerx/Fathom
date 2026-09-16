// The one module every future authenticated call goes through, so no future
// screen can make an unsigned call by accident. Nothing here is exported
// that lets a caller skip the nonce fetch or the signature -- `signedFetch`
// is the only way this client reaches a route that composes `Signed`
// (`crates/fathom-server/src/api.rs`).

import { readLp, toHex } from '../crypto/bytes';
import { signMessage } from '../crypto/keys';
import { bodyDigest, requestBytes } from '../crypto/session';
import { getSession, nextRequestCounter } from '../state/sessionState';
import { HEADER_COUNTER, HEADER_NONCE, HEADER_SESSION, HEADER_SIGNATURE, HEADER_TIMESTAMP, HEADER_TOKEN } from './constants';
import { refusalFrom } from './errors';

const EMPTY_BODY = new Uint8Array(0);

/**
 * `signedFetch`'s full result — added for `document/api/payload.ts`'s
 * `openDesign`, which needs `open_design_handler`'s response headers
 * (`fathom-design-version`, `fathom-payload-schema-version`) and not only
 * the body. `signedFetch` itself keeps its original signature and behaviour;
 * every existing caller is unaffected.
 */
export interface SignedResponse {
  bytes: Uint8Array;
  headers: Headers;
}

/**
 * Sign and send one request under the live session.
 *
 * `path` must be the exact request target -- path and query -- because that
 * is what `Signed`'s extractor reads off the request line
 * (`parts.uri.path_and_query()`) and signs. A caller that built a URL and
 * then let `fetch` normalise it before this function saw it would be
 * signing something other than what goes over the wire.
 */
export async function signedFetchWithHeaders(
  method: string,
  path: string,
  body: Uint8Array = EMPTY_BODY,
): Promise<SignedResponse> {
  const session = getSession();
  if (!session) {
    throw new Error('no active session: sign in first');
  }

  // §4.1: a signature needs a nonce and the caller has none yet, so one is
  // drawn per request from the bearer-token-authenticated endpoint. The
  // token buys exactly this and nothing more (`sessions::token_hash`'s own
  // doc comment).
  const nonceResponse = await fetch('/session/nonce', {
    method: 'POST',
    headers: {
      [HEADER_SESSION]: session.sessionId,
      [HEADER_TOKEN]: toHex(session.token),
    },
  });
  if (!nonceResponse.ok) {
    throw await refusalFrom(nonceResponse);
  }
  const { value: nonce } = readLp(new Uint8Array(await nonceResponse.arrayBuffer()));

  const unixMs = Date.now();
  const counter = nextRequestCounter();
  const digest = await bodyDigest(body);
  const message = requestBytes(session.sessionId, method, path, digest, nonce, unixMs, counter);
  const signature = await signMessage(session.sessionKeyPair.privateKey, message);

  const response = await fetch(path, {
    method,
    headers: {
      [HEADER_SESSION]: session.sessionId,
      [HEADER_TOKEN]: toHex(session.token),
      [HEADER_NONCE]: toHex(nonce),
      [HEADER_TIMESTAMP]: String(unixMs),
      [HEADER_COUNTER]: String(counter),
      [HEADER_SIGNATURE]: toHex(signature),
    },
    body: body.byteLength > 0 ? (body as BodyInit) : undefined,
  });
  if (!response.ok) {
    throw await refusalFrom(response);
  }
  return { bytes: new Uint8Array(await response.arrayBuffer()), headers: response.headers };
}

/** The body alone — every caller that does not need response headers. */
export async function signedFetch(
  method: string,
  path: string,
  body: Uint8Array = EMPTY_BODY,
): Promise<Uint8Array> {
  return (await signedFetchWithHeaders(method, path, body)).bytes;
}
