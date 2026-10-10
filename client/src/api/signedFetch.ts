// The one module every future authenticated call goes through, so no future
// screen can make an unsigned call by accident. Nothing here is exported
// that lets a caller skip the nonce fetch or the signature -- `signedFetch`
// is the only way this client reaches a route that composes `Signed`
// (`crates/fathom-server/src/api.rs`).

import { readLp, readU64LE, toHex } from '../crypto/bytes';
import { signMessage } from '../crypto/keys';
import { bodyDigest, requestBytes } from '../crypto/session';
import { clearGraceToken } from '../state/graceToken';
import { markSignedOutElsewhere } from '../state/signedOutNotice';
import {
  ACCOUNT_PLANE,
  clearPlane,
  ensureCounterAtLeast,
  getSessionOn,
  nextRequestCounter,
  sessionForPath,
  type ActiveSession,
  type Plane,
} from '../state/sessionState';
import { clearAccountSession, thisTabId, touchAccountSession } from '../state/tabSessions';
import { HEADER_COUNTER, HEADER_NONCE, HEADER_SESSION, HEADER_SIGNATURE, HEADER_TIMESTAMP, HEADER_TOKEN } from './constants';
import { refusalFrom } from './errors';

/**
 * Whether a status means this session is not live, rather than that this
 * particular request was refused. `sessions.rs` folds every dead-session
 * cause into `401` (ADR-0057 decision 8); everything else is a live session.
 */
export function isSessionDeathStatus(status: number): boolean {
  return status === 401;
}

/**
 * A `401` on an established session means it is not live —
 * `sessions.rs` folds every cause into one refusal on purpose. ADR-0057
 * decision 4: clear that plane, and its record on the account plane, so
 * sign-in shows instead of a screen retrying a dead session.
 *
 * ADR-0057 decision 8: also the moment a tab whose session ended elsewhere
 * finds out — a deliberate `signOut` clears the plane itself on `200` and
 * never reaches here.
 */
async function clearOnUnauthorized(plane: Plane, response: Response): Promise<never> {
  const refusal = await refusalFrom(response);
  if (isSessionDeathStatus(refusal.status)) {
    clearPlane(plane);
    if (plane === ACCOUNT_PLANE) {
      void clearAccountSession(thisTabId());
      clearGraceToken();
      markSignedOutElsewhere();
    }
  }
  throw refusal;
}

const EMPTY_BODY = new Uint8Array(0);

/**
 * How many signed requests one plane may have between drawing a nonce and
 * reading the answer's headers.
 *
 * **The server ends a session that is sent more than 32 at once.**
 * `sessions.rs` holds at most `MAX_OUTSTANDING_NONCES` (32) unspent nonces
 * per session and refuses a counter more than `COUNTER_WINDOW` (32) past the
 * mark its nonce was issued against; both refusals are a `401`, and a `401`
 * clears the plane (`clearOnUnauthorized`). Every request here draws its
 * nonce before any of them lands, so a burst of 33 or more shares one
 * issued mark and the 33rd is refused. Opening a design fetches every
 * catalogue model at once, and the home-lab models (#147) took the
 * catalogue from 16 to 55: opening any design signed the person out.
 *
 * Eight is well inside both bounds, and a browser runs no more than six
 * HTTP/1.1 requests to one host at a time anyway. The bound is here, in the
 * one module every signed call goes through, so that no future screen can
 * spend the session by asking for a lot at once.
 */
export const MAX_SIGNED_IN_FLIGHT = 8;

/** A first-come, first-served limit on how many tasks run at once. */
export class RequestGate {
  private readonly limit: number;
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.running += 1;
    }
    try {
      return await task();
    } finally {
      // The slot passes straight to the next in line, so `running` never
      // dips and lets a newcomer jump the queue.
      const next = this.waiting.shift();
      if (next) next();
      else this.running -= 1;
    }
  }
}

/** One gate per plane: the server's bounds are per session. */
const gates = new Map<Plane, RequestGate>();
function gateFor(plane: Plane): RequestGate {
  let gate = gates.get(plane);
  if (!gate) {
    gate = new RequestGate(MAX_SIGNED_IN_FLIGHT);
    gates.set(plane, gate);
  }
  return gate;
}

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
  background = false,
): Promise<SignedResponse> {
  // **Which session signs this** is the path's own question since ADR-0055
  // decision 1 put two of them in the browser at once: anything under
  // `/admin` is the operator's and everything else is the account's
  // (`../state/sessionState.ts`'s `planeForPath`). The counter spent is that
  // plane's counter, because the server's is monotone per session row.
  const held = sessionForPath(path);
  if (!held) {
    throw new Error('no active session: sign in first');
  }
  return send(held.plane, held.session, method, path, body, background);
}

/**
 * A signed GET whose body is read as it arrives (ADR-0063's live feed). The
 * caller reads `response.body`; `signal` ends it. Background: it does not
 * count as use of the session in this tab's own record.
 */
export async function signedStream(path: string, signal: AbortSignal): Promise<Response> {
  const held = sessionForPath(path);
  if (!held) {
    throw new Error('no active session: sign in first');
  }
  return sendRaw(held.plane, held.session, 'GET', path, EMPTY_BODY, signal);
}

/**
 * The same request, on a plane the caller names rather than one the path
 * implies. For `signOut`, which has to end **both** sessions and would
 * otherwise send `DELETE /session` twice under whichever one the path rule
 * picked.
 */
export async function signedFetchOn(
  plane: Plane,
  method: string,
  path: string,
  body: Uint8Array = EMPTY_BODY,
): Promise<Uint8Array> {
  const session = getSessionOn(plane);
  if (!session) {
    throw new Error(`no active session on the ${plane} plane`);
  }
  return (await send(plane, session, method, path, body)).bytes;
}

/**
 * One signed request, inside its plane's [`MAX_SIGNED_IN_FLIGHT`] gate. The
 * slot is held from the nonce until the answer's headers arrive, which is
 * when the server has spent the nonce and moved the counter; a live feed's
 * body goes on streaming after the slot is given back.
 */
function sendRaw(
  plane: Plane,
  session: ActiveSession,
  method: string,
  path: string,
  body: Uint8Array,
  signal?: AbortSignal,
): Promise<Response> {
  return gateFor(plane).run(() => sendRawNow(plane, session, method, path, body, signal));
}

async function sendRawNow(
  plane: Plane,
  session: ActiveSession,
  method: string,
  path: string,
  body: Uint8Array,
  signal?: AbortSignal,
): Promise<Response> {
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
    return clearOnUnauthorized(plane, nonceResponse);
  }
  // ADR-0057 decision 4: `LP(nonce) || u64(issued_counter)` — the counter
  // lets a tab restored after a reload resume from the server's mark
  // rather than restart at `1`, which `sessions.rs` would refuse outright.
  const nonceBytes = new Uint8Array(await nonceResponse.arrayBuffer());
  const { value: nonce, rest: afterNonce } = readLp(nonceBytes);
  const issuedCounter = Number(readU64LE(afterNonce));
  ensureCounterAtLeast(plane, issuedCounter);

  const unixMs = Date.now();
  const counter = nextRequestCounter(plane);
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
    signal,
  });
  if (!response.ok) {
    return clearOnUnauthorized(plane, response);
  }
  return response;
}

async function send(
  plane: Plane,
  session: ActiveSession,
  method: string,
  path: string,
  body: Uint8Array,
  background = false,
): Promise<SignedResponse> {
  const response = await sendRaw(plane, session, method, path, body);
  // Best effort, and only the plane decision 4 persists at all: a failure
  // here changes nothing about whether the request itself succeeded.
  if (plane === ACCOUNT_PLANE && !background) {
    void touchAccountSession(thisTabId());
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
