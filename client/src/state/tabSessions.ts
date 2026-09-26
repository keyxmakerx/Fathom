// ADR-0057 decision 4: a reload keeps the account signed in, in the same
// tab. Decision 6 excludes Site — never written here.
//
// A separate database from `../crypto/keys.ts`'s `fathom-enrolled-keys`:
// that one is read as every identity this browser can sign in as, and a
// session record is not an identity, so keeping them apart keeps that true.
//
// The session keypair stays non-extractable through the IndexedDB clone
// (`generateKeyPair`) — the WebCrypto spec and the Chromium, Firefox and
// WebKit sources agree. What actually ends a stolen session is the
// server's idle and absolute limits (`sessions.rs`'s `verify_inside`), not
// secrecy of the key bytes on disk.
//
// One record per tab: the tab id (128 random bits) lives in
// `sessionStorage`, which only a browser's "duplicate tab" copies and a
// reload of the same tab keeps. A copy is caught at load (`claimThisTab`)
// before it reads a record.

import type { ActiveSession, Plane } from './sessionState';
import { ACCOUNT_PLANE } from './sessionState';

const DB_NAME = 'fathom-tab-sessions';
const STORE = 'sessions';
const DB_VERSION = 1;

/** What one record holds -- `ActiveSession` plus the plane, since the store
 * has no column to carry that. */
export type StoredTabSession = ActiveSession & { plane: Plane; lastUsedUnix: number };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error as Error);
  });
}

function recordKey(tabId: string, plane: Plane): string {
  return `${tabId}:${plane}`;
}

/**
 * Save `session` for this tab. Account plane only — throws for the
 * operator plane, per decision 6.
 *
 * Best effort: a write failure just leaves the session live in memory for
 * the rest of this tab's life; it never becomes a reason to make the
 * keypair extractable (`../crypto/keys.ts`'s rule).
 */
export async function saveAccountSession(tabId: string, session: ActiveSession): Promise<void> {
  if (session.kind === 'operator') {
    throw new Error('decision 6: the operator (Site) session is never persisted');
  }
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const record: StoredTabSession = {
          ...session,
          plane: ACCOUNT_PLANE,
          lastUsedUnix: Date.now() / 1000,
        };
        tx.objectStore(STORE).put(record, recordKey(tabId, ACCOUNT_PLANE));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error as Error);
      });
    } finally {
      db.close();
    }
  } catch {
    // IndexedDB unavailable, full, or refused: memory-only for this tab.
  }
}

/** This tab's stored account session, or `null` if it has none — never
 * held one, already cleared, or storage is unavailable. */
export async function loadAccountSession(tabId: string): Promise<StoredTabSession | null> {
  try {
    const db = await openDb();
    try {
      return await new Promise<StoredTabSession | null>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const request = tx.objectStore(STORE).get(recordKey(tabId, ACCOUNT_PLANE));
        request.onsuccess = () => resolve((request.result as StoredTabSession | undefined) ?? null);
        request.onerror = () => reject(request.error as Error);
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Delete this tab's stored account session — sign-out, or a 401 this tab
 * reads as the session being gone. Never throws: the record is what it
 * tidies up, so a failure here has nothing left to report to. */
export async function clearAccountSession(tabId: string): Promise<void> {
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(recordKey(tabId, ACCOUNT_PLANE));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error as Error);
      });
    } finally {
      db.close();
    }
  } catch {
    // Nothing to do: the record this call means to remove may already be
    // unreachable for the same reason the delete itself would have failed.
  }
}

/**
 * Refresh this tab's stored `lastUsedUnix` — called after every signed
 * request on the account plane, so a restored record carries a true "last
 * active" rather than just when it was minted. Best effort and silent; the
 * server's `last_seen_at` is what anything authoritative checks against.
 */
export async function touchAccountSession(tabId: string): Promise<void> {
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const key = recordKey(tabId, ACCOUNT_PLANE);
        const getRequest = store.get(key);
        getRequest.onsuccess = () => {
          const record = getRequest.result as StoredTabSession | undefined;
          if (record) {
            store.put({ ...record, lastUsedUnix: Date.now() / 1000 }, key);
          }
        };
        getRequest.onerror = () => reject(getRequest.error as Error);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error as Error);
      });
    } finally {
      db.close();
    }
  } catch {
    // Best effort, as every write in this module is.
  }
}

/**
 * Deletes every record whose `expiresAtUnix` has passed (ADR-0057). Run
 * once at startup, before this tab's record is read, so an abandoned tab's
 * row is not read by a browser that later reuses its id.
 *
 * Absolute expiry only: idle death is the server's call (`sessions.rs`'s
 * `ACCOUNT_IDLE_LIMIT`/`OPERATOR_IDLE_LIMIT`); a record left past its idle
 * limit is simply refused the next time it is used.
 */
export async function sweepStaleTabSessions(nowUnix: number = Date.now() / 1000): Promise<void> {
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const record = cursor.value as StoredTabSession;
          if (record.expiresAtUnix <= nowUnix) {
            cursor.delete();
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error as Error);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error as Error);
      });
    } finally {
      db.close();
    }
  } catch {
    // Nothing to sweep, or nothing this tab can reach; the server's
    // limits are the real control regardless.
  }
}

// ---------------------------------------------------------------------------
// The tab id, and the lock a copy of this tab cannot also hold
// ---------------------------------------------------------------------------

const TAB_ID_KEY = 'fathom-tab-id';
const LOCK_PREFIX = 'fathom-tab-session-lock:';
const BROADCAST_CHANNEL_NAME = 'fathom-tab-sessions';

function randomTabId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A fallback for a caller with no `sessionStorage` — Node's test
 * environment, never a real browser. Kept in module memory alone, stable
 * for this module instance's life and nowhere else. */
let idWithoutSessionStorage: string | null = null;

function hasSessionStorage(): boolean {
  return typeof sessionStorage !== 'undefined';
}

/** This tab's id, minted into `sessionStorage` on first read. A new tab
 * gets a fresh one; a reload of this tab, or a browser's "duplicate tab",
 * reads the same one back — the case `claimThisTab` exists to catch. */
export function thisTabId(): string {
  if (!hasSessionStorage()) {
    idWithoutSessionStorage ??= randomTabId();
    return idWithoutSessionStorage;
  }
  let id = sessionStorage.getItem(TAB_ID_KEY);
  if (!id) {
    id = randomTabId();
    sessionStorage.setItem(TAB_ID_KEY, id);
  }
  return id;
}

/** Replace this tab's id with a fresh one — what a caught copy does before
 * it goes to sign-in, so it never again presents the id the original tab
 * still holds the lock for. */
function mintFreshTabId(): string {
  const id = randomTabId();
  if (hasSessionStorage()) {
    sessionStorage.setItem(TAB_ID_KEY, id);
  } else {
    idWithoutSessionStorage = id;
  }
  return id;
}

let ownBroadcastChannel: BroadcastChannel | null = null;

function broadcastChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!ownBroadcastChannel) {
    ownBroadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
  }
  return ownBroadcastChannel;
}

/** Tell every other tab this account session changed — sign-out, or a 401
 * read as the session being gone — so a genuine copy sharing this tab's id
 * does not keep offering a record already decided gone. Best effort and
 * silent. */
export function announceSessionsChanged(): void {
  try {
    broadcastChannel()?.postMessage({ type: 'sessions-changed' });
  } catch {
    // Nothing to announce to.
  }
}

/**
 * Claim this tab's id, or find that a live copy of this tab already holds
 * it (ADR-0057 decision 4).
 *
 * Web Locks, feature-detected — supported by every secure-context browser
 * this client runs in (MDN). A lock named for this tab's id is held for
 * the page's life, so a "duplicate tab" — which copies `sessionStorage`
 * and this tab's id with it — finds the original tab still holding it and
 * is refused.
 *
 * No fallback: a `BroadcastChannel` guess would be weaker by construction
 * — a race inside its claim window is exactly the copy this exists to
 * catch — and every supported browser has Web Locks. Without a claim,
 * this tab mints a fresh id and signs in fresh, like a genuine copy.
 *
 * Returns the id this tab should use from here on: unchanged if the claim
 * succeeded, freshly minted if it did not.
 */
export async function claimThisTab(): Promise<{ tabId: string; isCopy: boolean }> {
  const id = thisTabId();
  const acquired =
    typeof navigator !== 'undefined' && 'locks' in navigator ? await claimWithWebLock(id) : false;
  if (acquired) {
    return { tabId: id, isCopy: false };
  }
  return { tabId: mintFreshTabId(), isCopy: true };
}

function claimWithWebLock(id: string): Promise<boolean> {
  return new Promise((resolveAcquired) => {
    navigator.locks
      .request(LOCK_PREFIX + id, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolveAcquired(false);
          return Promise.resolve();
        }
        resolveAcquired(true);
        // Held for the rest of this tab's life: the browser releases it
        // when the page is torn down (navigation, close, reload), and
        // nothing here ever resolves this promise itself.
        return new Promise<void>(() => {});
      })
      .catch(() => resolveAcquired(false));
  });
}

