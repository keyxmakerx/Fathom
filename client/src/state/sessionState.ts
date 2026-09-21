// The one place this client holds a live session. Not persisted: the
// session private key is `extractable: false` and was never exported, so it
// cannot survive a reload anyway -- a reload means signing in again, which
// is a deliberate simplification for this slice rather than a limit of the
// approach (a future slice could persist the session keypair itself,
// non-extractable, the same way `crypto/keys.ts` already persists an
// enrolled one).

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

type Listener = () => void;

let current: ActiveSession | null = null;
let requestCounter = 0;
const listeners = new Set<Listener>();

export function getSession(): ActiveSession | null {
  return current;
}

export function setSession(session: ActiveSession | null): void {
  current = session;
  requestCounter = 0;
  for (const listener of listeners) {
    listener();
  }
}

/** For `useSyncExternalStore`, so the shell re-renders the moment a sign-in
 * or sign-out changes which screen is current. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The next value for `sessions::request_bytes`'s `request_counter`.
 *
 * `sessions.rs` requires strictly more than the counter that was live when
 * the nonce being spent was issued (`request.counter <= issued_counter` is
 * refused as `CounterNotFresh`) -- anti-replay against a network observer,
 * not against the row itself. A value that only ever increases for the life
 * of one in-memory session satisfies that without this client reading a
 * column it has no way to see.
 */
export function nextRequestCounter(): number {
  requestCounter += 1;
  return requestCounter;
}
