// Where this client holds its live sessions. Not persisted: a session
// private key is `extractable: false` and was never exported, so it cannot
// survive a reload anyway -- a reload means signing in again, which is a
// deliberate simplification for this slice rather than a limit of the
// approach (a future slice could persist the session keypair itself,
// non-extractable, the same way `crypto/keys.ts` already persists an
// enrolled one).
//
// **Two sessions at once since ADR-0055 decision 1.** One person, two
// custodies: the account they sign in as, and -- when that account holds the
// operator custody -- the operator they pick up in the console. They are two
// server sessions with two principals, two tokens and two session keypairs,
// and the browser holds both, because entering the console must not sign the
// person out of their own account and Home must stay one press away.
//
// Each session carries **its own request counter**. `sessions.rs` refuses a
// request whose counter is not strictly greater than the counter that was
// live when the nonce it spends was issued, and the column is monotone per
// session row (`GREATEST`), so one shared counter would be spent by whichever
// plane made a request last and the other plane's next request would be
// refused as `CounterNotFresh`. Setting a session aside and coming back to it
// is exactly what the console entry does, so the counters are per plane.

import type { PrincipalKind } from '../api/constants';

export interface ActiveSession {
  sessionId: string;
  /** Which plane this session is on (`../api/constants.ts`). An operator
   * session lands on the operator console and nowhere else; a steward
   * session lands on Home. `address` is the operator id for the former. */
  kind: PrincipalKind;
  token: Uint8Array;
  sessionKeyPair: CryptoKeyPair;
  expiresAtUnix: number;
  /** The address this session signed in as. Not part of any server message
   * this client reads back — kept only so the shell can show who is signed
   * in without a round trip for it. */
  address: string;
  /** The signed-in principal's ulid, `POST /session`'s fourth answer field
   * (ADR-0053 §3, `../api/auth.ts`'s `parseSignInAnswer`). This is the value
   * every command dispatched while this session is live is stamped with as
   * its actor, so a provenance record or a tombstone names who really made
   * it rather than `document/model.ts`'s `LOCAL_ACTOR` placeholder. */
  accountId: string;
}

/** The two planes a session can be on. Not the same word as
 * `PrincipalKind`: every non-operator principal signs in on the account
 * plane, and the operator custody is the other one. */
export type Plane = 'account' | 'operator';

export const ACCOUNT_PLANE: Plane = 'account';
export const OPERATOR_PLANE: Plane = 'operator';

/** Which plane a session of this kind belongs on. */
export function planeOfKind(kind: PrincipalKind): Plane {
  return kind === 'operator' ? OPERATOR_PLANE : ACCOUNT_PLANE;
}

/**
 * Which session a request on `path` is made under.
 *
 * **Anything under `/admin` is the operator's.** That is not a guess about
 * the route: `admin.rs`'s router is the operator plane, `admin_exposure`
 * confines it to the console host, and every route beneath it verifies an
 * operator session -- with the single exception of
 * `POST /admin/operators/self/key`, which an ACCOUNT session makes to pick
 * the custody up in the first place. That exception needs no rule here: at
 * the moment it is made there is no operator session yet, and the fallback
 * below hands the request to the account.
 *
 * Everything else -- designs, credentials, organisations, the session
 * routes -- is the account's.
 */
export function planeForPath(path: string): Plane {
  return path === '/admin' || path.startsWith('/admin/') || path.startsWith('/admin?')
    ? OPERATOR_PLANE
    : ACCOUNT_PLANE;
}

type Listener = () => void;

const sessions: Record<Plane, ActiveSession | null> = { account: null, operator: null };
const counters: Record<Plane, number> = { account: 0, operator: 0 };
/** Which plane the person is looking at. The console is the operator plane;
 * everything else is the account's. */
let inView: Plane = ACCOUNT_PLANE;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** The session of the plane in view -- what the shell renders from. */
export function getSession(): ActiveSession | null {
  return sessions[inView];
}

/** One named plane's session, whether or not it is the one in view. */
export function getSessionOn(plane: Plane): ActiveSession | null {
  return sessions[plane];
}

/** Which plane is in view. */
export function getPlane(): Plane {
  return inView;
}

/** Every session this browser holds, for the caller that has to act on all
 * of them -- `api/auth.ts`'s `signOut`, which ends both. */
export function heldSessions(): { plane: Plane; session: ActiveSession }[] {
  const held: { plane: Plane; session: ActiveSession }[] = [];
  for (const plane of [ACCOUNT_PLANE, OPERATOR_PLANE] as Plane[]) {
    const session = sessions[plane];
    if (session) held.push({ plane, session });
  }
  return held;
}

/**
 * The session a request on `path` is signed with, and the plane whose
 * counter it spends.
 *
 * The path's own plane first; then, when that plane holds nothing, whatever
 * plane is in view. The fallback is what carries
 * `POST /admin/operators/self/key` under the account session, and what lets
 * an operator-only browser reach `/session/nonce` and `DELETE /session`.
 */
export function sessionForPath(path: string): { plane: Plane; session: ActiveSession } | null {
  const wanted = planeForPath(path);
  const onPlane = sessions[wanted];
  if (onPlane) return { plane: wanted, session: onPlane };
  const inViewSession = sessions[inView];
  if (inViewSession) return { plane: inView, session: inViewSession };
  const other: Plane = wanted === ACCOUNT_PLANE ? OPERATOR_PLANE : ACCOUNT_PLANE;
  const fallback = sessions[other];
  return fallback ? { plane: other, session: fallback } : null;
}

/**
 * Install a session, or -- with `null` -- end every session this browser
 * holds.
 *
 * A session is filed on the plane its `kind` belongs to and that plane comes
 * into view, because every caller that installs one is a sign-in the person
 * just made. `null` clears BOTH planes: signing out signs the whole person
 * out, not the custody they happen to be looking at.
 */
export function setSession(session: ActiveSession | null): void {
  if (session === null) {
    sessions.account = null;
    sessions.operator = null;
    counters.account = 0;
    counters.operator = 0;
    inView = ACCOUNT_PLANE;
    notify();
    return;
  }
  const plane = planeOfKind(session.kind);
  sessions[plane] = session;
  counters[plane] = 0;
  inView = plane;
  notify();
}

/** Put one plane down without ending the other -- leaving the console for
 * Home, or coming back to it. Does nothing when that plane holds no
 * session, so no screen can put the shell in view of an empty plane. */
export function setPlane(plane: Plane): void {
  if (sessions[plane] === null || inView === plane) return;
  inView = plane;
  notify();
}

/**
 * End one plane's session without touching the other — ADR-0057 decision
 * 4: a `401` on one plane's session does not mean the other is dead.
 * `setSession(null)` still ends both, for a deliberate sign-out.
 *
 * Does nothing if that plane already holds no session, and falls back to
 * the account plane if the one just cleared was in view.
 */
export function clearPlane(plane: Plane): void {
  if (sessions[plane] === null) return;
  sessions[plane] = null;
  counters[plane] = 0;
  if (inView === plane) inView = ACCOUNT_PLANE;
  notify();
}

/** For `useSyncExternalStore`, so the shell re-renders the moment a sign-in,
 * a sign-out or a change of plane changes which screen is current. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The next value for `sessions::request_bytes`'s `request_counter`, on one
 * plane.
 *
 * `sessions.rs` requires strictly more than the counter that was live when
 * the nonce being spent was issued (`request.counter <= issued_counter` is
 * refused as `CounterNotFresh`) -- anti-replay against a network observer,
 * not against the row itself. A value that only ever increases for the life
 * of one in-memory session satisfies that without this client reading a
 * column it has no way to see; one counter per plane satisfies it for both
 * sessions at once.
 */
export function nextRequestCounter(plane: Plane = inView): number {
  counters[plane] += 1;
  return counters[plane];
}

/**
 * Raise `plane`'s counter to at least `floor`, never lower it.
 *
 * ADR-0057 decision 4: a restored tab's counter starts at `0` like a fresh
 * sign-in, while the session row already carries a higher mark. Called
 * with `issued_counter` on every request; a session that was never
 * restored is already ahead of it, so this is a no-op there.
 */
export function ensureCounterAtLeast(plane: Plane, floor: number): void {
  if (counters[plane] < floor) {
    counters[plane] = floor;
  }
}
