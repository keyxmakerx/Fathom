// Where the console lives, and how an account's browser picks up the
// operator custody it holds -- ADR-0055 decisions 9 and 11, against
// `crates/fathom-server/src/placement.rs` and `admin.rs`'s stream (b) block.
//
// Three things live here, and they are here together because they are the
// same question asked at three moments:
//
//   1. `useConsoleHost()` -- *does the console answer on the host this page
//      was served from?* `GET /placement/flag`, unauthenticated, once per
//      page load. Decision 9: on any other host every operator control is
//      **absent**, not hidden, so the answer is read before a control is
//      rendered rather than used to style one.
//   2. `bootstrapOperatorSession()` -- the account that holds the operator
//      custody registers this browser's key as its OPERATOR key and then
//      signs in as the operator, so the browser holds two sessions: the
//      account's and the operator's (decision 1).
//   3. `requestPlacement()` -- moving the console, with the operator's
//      enrolled key over `placement::placement_request_bytes`.
//
// Every byte layout below is assembled here from `placement.rs`'s own doc
// comments, not read back from any generated artefact: `placement.test.ts`
// checks them against vectors computed independently of this file, the way
// `crypto/session.test.ts` and `api/console.test.ts` already do.

import { useEffect, useState } from 'react';

import { concatBytes, lp, readLp, readU64LE, u64LE, utf8 } from '../crypto/bytes';
import {
  exportPublicKeyRaw,
  generateKeyPair,
  getEnrolledKeyPair,
  putEnrolledKeyPair,
  signMessage,
} from '../crypto/keys';
import { sessionChallenge } from '../crypto/session';
import { getSession, type ActiveSession } from '../state/sessionState';
import { parseSignInAnswer } from './auth';
import { keySlot, PRINCIPAL_KIND_OPERATOR } from './constants';
import { ApiRefusal, refusalFrom } from './errors';
import { signedFetch } from './signedFetch';

// ---------------------------------------------------------------------------
// The console-host flag
// ---------------------------------------------------------------------------

/**
 * What decided that this host does, or does not, answer for the console --
 * `GET /placement/flag`'s **third** field.
 *
 *   - `environment`: `FATHOM_ADMIN_HOSTS` / `FATHOM_ADMIN_SOURCES` are set,
 *     and decision 11 says they win outright. The placement form is
 *     read-only and says so.
 *   - `console`: a placement saved in the console decides.
 *   - `open`: nothing decides; the console answers everywhere.
 *
 * `null` means the server did not say. **That is not a fourth verdict and
 * must not be read as one**: the field is absent on the server binary this
 * client is built against today, and the honest response to an absent field
 * is to say nothing about it (`PlacementForm.tsx` falls back to what it can
 * observe, and says that is what it is doing).
 */
export type PlacementDecider = 'environment' | 'console' | 'open';

const DECIDERS: readonly string[] = ['environment', 'console', 'open'];

/** `GET /placement/flag`'s answer: `LP("yes"|"no")`, and when the answer is
 * "yes", `LP(confirm_by as text)` -- empty text when nothing is waiting to
 * be confirmed, so the shape does not depend on which of the two it is
 * (`placement.rs`'s `flag`) -- and, **optionally**, `LP(decided_by)`. */
export interface ConsoleFlag {
  /** Whether a console request from this host would be answered at all. */
  consoleHost: boolean;
  /** The unix second an unconfirmed placement stops being honoured, or
   * `null` when nothing is pending. */
  confirmByUnix: number | null;
  /** Which of the environment, a saved placement or nothing at all decided
   * the verdict above, or `null` when the server did not say. */
  decidedBy: PlacementDecider | null;
}

/**
 * The optional last field, read off whatever is left.
 *
 * Nothing left is the ordinary answer from the server binary this client is
 * built against today, and it is `null` and not an error. Bytes that are
 * left but are not one well-formed LP field ARE an error, and the message is
 * the one this parser has always given for trailing bytes -- a client that
 * read a stray byte as a decider would be inventing the very fact the field
 * exists to stop it inventing.
 */
function readOptionalDecider(rest: Uint8Array): PlacementDecider | null {
  if (rest.length === 0) return null;
  let value: Uint8Array;
  let after: Uint8Array;
  try {
    ({ value, rest: after } = readLp(rest));
  } catch {
    throw new Error(`malformed placement flag: ${rest.length} trailing byte(s)`);
  }
  if (after.length !== 0) {
    throw new Error(`malformed placement flag: ${after.length} trailing byte(s)`);
  }
  const text = new TextDecoder().decode(value).trim();
  if (!DECIDERS.includes(text)) {
    throw new Error(`malformed placement flag decider: ${JSON.stringify(text)}`);
  }
  return text as PlacementDecider;
}

export function parseFlagAnswer(bytes: Uint8Array): ConsoleFlag {
  const { value: verdict, rest } = readLp(bytes);
  const text = new TextDecoder().decode(verdict);
  if (text !== 'yes' && text !== 'no') {
    throw new Error(`malformed placement flag: ${JSON.stringify(text)}`);
  }
  if (text === 'no') {
    // "no" carries one field on today's binary. A decider after it is read
    // if it is there, because the field is the server's to add and this is
    // the host where being told which rule confined the console matters
    // most.
    return { consoleHost: false, confirmByUnix: null, decidedBy: readOptionalDecider(rest) };
  }
  const { value: deadline, rest: after } = readLp(rest);
  const decidedBy = readOptionalDecider(after);
  const deadlineText = new TextDecoder().decode(deadline).trim();
  if (deadlineText.length === 0) {
    return { consoleHost: true, confirmByUnix: null, decidedBy };
  }
  const confirmByUnix = Number.parseInt(deadlineText, 10);
  if (!Number.isFinite(confirmByUnix)) {
    throw new Error(`malformed placement flag deadline: ${JSON.stringify(deadlineText)}`);
  }
  return { consoleHost: true, confirmByUnix, decidedBy };
}

export async function fetchConsoleFlag(): Promise<ConsoleFlag> {
  const response = await fetch('/placement/flag');
  if (!response.ok) {
    throw await refusalFrom(response);
  }
  return parseFlagAnswer(new Uint8Array(await response.arrayBuffer()));
}

/** The one read per page load. A second caller gets the first caller's
 * promise: two components asking the same question of the same page must
 * not be able to get two answers, and the answer cannot change without a
 * navigation, which is a new page load. */
let flagOnce: Promise<ConsoleFlag> | null = null;

export function consoleFlag(): Promise<ConsoleFlag> {
  if (flagOnce === null) {
    flagOnce = fetchConsoleFlag();
  }
  return flagOnce;
}

/** For a test that needs the next `consoleFlag()` to ask again. Not called
 * by any screen: a page load is what refreshes this. */
export function forgetConsoleFlag(): void {
  flagOnce = null;
}

export type ConsoleHostState =
  | { status: 'loading' }
  | { status: 'ready'; flag: ConsoleFlag }
  | { status: 'error'; message: string };

/**
 * Decision 9's answer, as a hook: `App.tsx` asks it before it offers an
 * operator door, and the console asks it before it renders a control.
 *
 * While it is loading nothing operator-side is rendered by either caller --
 * a control that appeared and then vanished would be a control that existed.
 */
export function useConsoleHost(): ConsoleHostState {
  const [state, setState] = useState<ConsoleHostState>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    consoleFlag()
      .then((flag) => {
        if (!cancelled) setState({ status: 'ready', flag });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message:
              error instanceof ApiRefusal || error instanceof Error
                ? error.message
                : 'The server did not say whether this host is the console host.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

// ---------------------------------------------------------------------------
// The deployment id, which every operator assertion is signed over
// ---------------------------------------------------------------------------

/**
 * `POST /session/challenge` answers `LP(nonce) ‖ LP(deployment_id)`, and
 * **no other route in this server hands the deployment id to a client**
 * (read off `api.rs`, `admin.rs`, `lib.rs` and `placement.rs` on
 * 2026-09-21). Every operator assertion -- a settings change, a colleague, a
 * placement -- is signed over it (`operators::setting_request_bytes`,
 * `placement::placement_request_bytes`), so the console has to have it.
 *
 * So it is read from a challenge drawn for the operator this session already
 * is, and the nonce that comes with it is discarded. The cost is one
 * `session_nonces` row and one unit of this source's sign-in budget
 * (forty-five per fifteen minutes, `sessions::SignInLimits::defaults`), paid
 * **once per page load**, not per act. For scale: a two-step sign-in spends
 * three of those units — the challenge, the second-factor probe and the
 * completion (ADR-0056 decision 3, 2026-09-22) — and a one-shot sign-in
 * spends two.
 *
 * The cheaper alternative is for sign-in to keep the deployment id it was
 * already told, which is one field on `state/sessionState.ts` and belongs to
 * whoever owns that file; this is written so the console works either way.
 */
let deploymentOnce: Promise<string> | null = null;

export async function deploymentId(operatorId: string): Promise<string> {
  if (deploymentOnce === null) {
    deploymentOnce = readDeploymentId(operatorId);
  }
  return deploymentOnce;
}

export function forgetDeploymentId(): void {
  deploymentOnce = null;
}

async function readDeploymentId(operatorId: string): Promise<string> {
  const throwaway = await generateKeyPair();
  const pubkey = await exportPublicKeyRaw(throwaway.publicKey);
  const { deploymentId: id } = await challenge(PRINCIPAL_KIND_OPERATOR, operatorId, pubkey);
  return id;
}

async function challenge(
  kind: string,
  principal: string,
  sessionPubkey: Uint8Array,
): Promise<{ nonce: Uint8Array; deploymentId: string }> {
  const body = concatBytes(lp(utf8(kind)), lp(utf8(principal)), lp(sessionPubkey));
  const response = await fetch('/session/challenge', { method: 'POST', body: body as BodyInit });
  if (!response.ok) {
    throw await refusalFrom(response);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const { value: nonce, rest } = readLp(bytes);
  const { value: deployment } = readLp(rest);
  return { nonce, deploymentId: new TextDecoder().decode(deployment) };
}

/**
 * Sign `message` with the operator key this browser holds -- the key
 * `bootstrapOperatorSession` registered, filed under `operator:<id>`
 * (`api/constants.ts`'s `keySlot`).
 *
 * **Not the session key.** `placement::verify_operator_assertion` and
 * `operators.rs`'s twin check it against `live_operator_key`, so every
 * operator act is a touch of the long-term key and not a form submission
 * (§5.5).
 */
export async function signOperatorAssertion(operatorId: string, message: Uint8Array): Promise<Uint8Array> {
  const pair = await getEnrolledKeyPair(keySlot(PRINCIPAL_KIND_OPERATOR, operatorId));
  if (!pair) {
    throw new Error(
      'This browser holds no operator key for this session, so it cannot sign an operator act. Sign in again in the browser that registered the key.',
    );
  }
  return signMessage(pair.privateKey, message);
}

// ---------------------------------------------------------------------------
// Decision 1: one person, two sessions
// ---------------------------------------------------------------------------

export interface OperatorBootstrap {
  /** The operator session, **not** installed: the caller decides when the
   * browser changes planes (`state/sessionState.ts`'s `setSession`). */
  session: ActiveSession;
  operatorId: string;
  keyId: string;
}

/** `POST /admin/operators/self/key`'s answer: `LP(key_id) ‖ LP(operator_id)`. */
export function parseOperatorKeyAnswer(bytes: Uint8Array): { keyId: string; operatorId: string } {
  const { value: keyIdBytes, rest } = readLp(bytes);
  const { value: operatorIdBytes, rest: after } = readLp(rest);
  if (after.length !== 0) {
    throw new Error(`malformed operator key answer: ${after.length} trailing byte(s)`);
  }
  return {
    keyId: new TextDecoder().decode(keyIdBytes),
    operatorId: new TextDecoder().decode(operatorIdBytes),
  };
}

/** `POST /session`'s six fields (ADR-0055 decision 10). The operator plane
 * carries neither a password nor a verification code: `sessions.rs`'s branch 1,
 * *"resolution 8 keeps `kind = 'operator'` a key sign-in"*. */
export function buildOperatorSignInBody(
  sessionPubkey: Uint8Array,
  nonce: Uint8Array,
  evidenceSig: Uint8Array,
): Uint8Array {
  return concatBytes(
    lp(utf8(PRINCIPAL_KIND_OPERATOR)),
    lp(sessionPubkey),
    lp(nonce),
    lp(evidenceSig),
    lp(new Uint8Array(0)),
    lp(new Uint8Array(0)),
  );
}

/**
 * The account picks up the custody it holds.
 *
 * Two acts, in this order and no other:
 *
 *  1. `POST /admin/operators/self/key` with `LP(public_key)`, **signed by the
 *     ACCOUNT session** -- the person, with their password and their
 *     authenticator behind them. It is under `/admin`, so it only answers on a console host
 *     (the lead's resolution 8), which is why `useConsoleHost()` gates the
 *     door that calls this.
 *  2. the operator's own sign-in, with that same browser key as the evidence
 *     and no password, which yields the operator session every operator act
 *     is then made under.
 *
 * `accountSession` must be the session in view when this is called: step 1
 * has to be made as the account, and `state/sessionState.ts` routes a
 * request under `/admin` to the operator plane the moment one exists. Before
 * that it falls back to the plane in view, which is what carries step 1. The
 * check is explicit rather than implied, because the failure it prevents --
 * registering an operator key under the wrong session -- is silent.
 *
 * The operator session that comes back is **not** installed here. The caller
 * installs it (`setSession`), which files it on the operator plane beside
 * the account session rather than in place of it: decision 1's one person
 * with two custodies, and the reason Home is still reachable from the
 * console.
 *
 * Refusals arrive as [`ApiRefusal`] with the server's own sentence: a seat
 * hold after a password reset, an account that holds no operator custody,
 * and a console that does not answer on this host are all one of those and
 * none of them is interpreted here.
 */
export async function bootstrapOperatorSession(
  accountSession: ActiveSession,
  browserKey: CryptoKeyPair,
): Promise<OperatorBootstrap> {
  const live = getSession();
  if (!live || live.sessionId !== accountSession.sessionId) {
    throw new Error('the account session must be the live session before its operator key is registered');
  }
  const publicKey = await exportPublicKeyRaw(browserKey.publicKey);
  const { keyId, operatorId } = parseOperatorKeyAnswer(
    await signedFetch('POST', '/admin/operators/self/key', lp(publicKey)),
  );

  // **File the pair under the operator's own slot.** The server has recorded
  // it as this operator's `live_operator_key`, and every operator act from
  // here on is signed with it, not with the session key
  // (`signOperatorAssertion`, `placement::verify_operator_assertion`). Filed
  // before the sign-in below, so a browser that is interrupted between the
  // two still holds the key the server already knows about; and filed only
  // after the server's answer named the operator, which is the same
  // discipline `api/enrolment.ts` follows.
  await putEnrolledKeyPair(keySlot(PRINCIPAL_KIND_OPERATOR, operatorId), browserKey);

  const sessionKeyPair = await generateKeyPair();
  const sessionPubkey = await exportPublicKeyRaw(sessionKeyPair.publicKey);
  const { nonce, deploymentId: deployment } = await challenge(
    PRINCIPAL_KIND_OPERATOR,
    operatorId,
    sessionPubkey,
  );
  const bound = await sessionChallenge(sessionPubkey, nonce, deployment);
  const evidence = await signMessage(browserKey.privateKey, bound);
  const response = await fetch('/session', {
    method: 'POST',
    body: buildOperatorSignInBody(sessionPubkey, nonce, evidence) as BodyInit,
  });
  if (!response.ok) {
    throw await refusalFrom(response);
  }
  const { sessionId, token, expiresAtUnix, accountId } = parseSignInAnswer(
    new Uint8Array(await response.arrayBuffer()),
  );
  deploymentOnce = Promise.resolve(deployment);
  return {
    keyId,
    operatorId,
    session: {
      sessionId,
      kind: PRINCIPAL_KIND_OPERATOR,
      token,
      sessionKeyPair,
      expiresAtUnix,
      address: operatorId,
      accountId,
    },
  };
}

// ---------------------------------------------------------------------------
// Decision 11: moving the console
// ---------------------------------------------------------------------------

/** `placement::DEFAULT_WINDOW_SECONDS` and the bounds `0020`'s CHECK and
 * `PlacementStore::request` both enforce. The window cannot be turned off:
 * the owner's words, 2026-09-21. */
export const DEFAULT_WINDOW_SECONDS = 300;
export const MIN_WINDOW_SECONDS = 60;
export const MAX_WINDOW_SECONDS = 3600;

/** What `placement::sources_text` writes when the operator names no source:
 * `0020` requires the column to be non-empty, so "from anywhere" is spelled
 * out rather than left blank -- and the form says so before it is saved. */
export const EVERYWHERE_SOURCES = '0.0.0.0/0,::/0';

const TAG_PLACEMENT_REQUEST = 'fathom/site/placement/request/v1';

/** The operator's own text, trimmed -- `check_hosts` returns exactly that
 * and the signature covers exactly that. */
export function normalisePlacementHosts(text: string): string {
  return text.trim();
}

/** `placement::sources_text`: trimmed, or the whole internet when empty. */
export function normalisePlacementSources(text: string): string {
  const trimmed = text.trim();
  return trimmed.length === 0 ? EVERYWHERE_SOURCES : trimmed;
}

/**
 * `placement::placement_request_bytes`:
 * `LP(tag) ‖ LP(deployment) ‖ LP(operator) ‖ LP(hosts) ‖ LP(sources) ‖
 *  u64_le(window_seconds)`.
 *
 * The window is inside the signature because a proxy that shortened it
 * would otherwise be choosing when the console reverts.
 */
export function placementRequestBytes(
  deployment: string,
  operator: string,
  hosts: string,
  sources: string,
  windowSeconds: number,
): Uint8Array {
  return concatBytes(
    lp(utf8(TAG_PLACEMENT_REQUEST)),
    lp(utf8(deployment)),
    lp(utf8(operator)),
    lp(utf8(hosts)),
    lp(utf8(sources)),
    u64LE(windowSeconds),
  );
}

/** `POST /admin/placement`'s body: **four** fields, the window among them
 * (the lead's departure from the build contracts, `request_placement`). */
export function buildPlacementBody(
  hosts: string,
  sources: string,
  windowSeconds: number,
  assertion: Uint8Array,
): Uint8Array {
  return concatBytes(lp(utf8(hosts)), lp(utf8(sources)), lp(utf8(String(windowSeconds))), lp(assertion));
}

/** The answer: `LP(id) ‖ u64(confirm_by)`. */
export interface PlacementRequested {
  id: string;
  confirmByUnix: number;
}

export function parsePlacementAnswer(bytes: Uint8Array): PlacementRequested {
  const { value: idBytes, rest } = readLp(bytes);
  if (rest.length !== 8) {
    throw new Error(`malformed placement answer: ${rest.length} byte(s) where u64(confirm_by) belongs`);
  }
  return {
    id: new TextDecoder().decode(idBytes),
    confirmByUnix: Number(readU64LE(rest)),
  };
}

export interface PlacementRequest {
  operatorId: string;
  hosts: string;
  sources: string;
  windowSeconds: number;
}

/**
 * Move the console. **It applies at once** -- there is no delay and no
 * second operator -- and the window starts running the moment the server
 * answers, which is why the form warns before it calls this and counts down
 * after it.
 */
export async function requestPlacement(request: PlacementRequest): Promise<PlacementRequested> {
  const hosts = normalisePlacementHosts(request.hosts);
  const sources = normalisePlacementSources(request.sources);
  const deployment = await deploymentId(request.operatorId);
  const assertion = await signOperatorAssertion(
    request.operatorId,
    placementRequestBytes(deployment, request.operatorId, hosts, sources, request.windowSeconds),
  );
  return parsePlacementAnswer(
    await signedFetch(
      'POST',
      '/admin/placement',
      buildPlacementBody(hosts, sources, request.windowSeconds, assertion),
    ),
  );
}

/**
 * Where the browser goes next: the first host of the new placement, on this
 * page's own scheme, port and path.
 *
 * **The scheme is kept, not forced to `https`.** The console should be
 * behind TLS and the server sends HSTS when a trusted proxy says it is
 * (decision 12) -- but an install served over plain HTTP that was sent to
 * `https://` would be sent to a port nothing listens on, which is the
 * lockout this whole interlock exists to survive. A page already on
 * `https:` stays on it.
 *
 * The port is kept because a placement stores none:
 * `admin_exposure::normalise_host` strips the port from the `Host` header
 * before it compares, so a host list says nothing about which port the
 * console answers on.
 */
export function consoleUrlForHost(
  host: string,
  from: { protocol: string; port: string; pathname: string },
): string {
  const first = host.split(',')[0].trim();
  if (first.length === 0) {
    throw new Error('a placement with no host cannot be followed');
  }
  const port = from.port.length > 0 ? `:${from.port}` : '';
  return `${from.protocol}//${first}${port}${from.pathname}`;
}
