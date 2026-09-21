// The two keypairs a sign-in touches, kept in one small module so nothing
// else in this client has its own idea of how either is produced or stored.
// Both are generated the same way -- `generateKeyPair` below -- and differ
// only in lifetime and what stores them:
//
// 1. The SESSION keypair -- fresh every sign-in, P-256, generated here with
//    `extractable: false` on the private half. It never leaves the browser
//    and is never serialised; only its public half (SEC1 uncompressed,
//    exported once) and signatures made with it ever go over the wire. It
//    signs every request for the life of the session (12h --
//    `sessions::SESSION_LIFETIME`). `../api/auth.ts`'s `signIn` generates
//    one on every call and never stores it beyond the session itself.
//
// 2. The ENROLLED (account) keypair -- long-lived, proves who the session
//    belongs to by signing the sign-in challenge once. `../api/enrolment.ts`
//    generates one per invitation redeemed, non-extractable the same way,
//    and stores it here under `address` -- first in the PENDING slot,
//    before the network call that spends the invitation token, then
//    promoted to the ENROLLED slot only once that call's answer is read as
//    a definite OK. `getEnrolledKeyPair` and `getPendingKeyPair` are what
//    `signIn` reads from; see its doc comment for why it falls back to the
//    pending slot.

import { normalizeLowS } from './p256';

const ECDSA_P256: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_ALG: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' };

/** A fresh, non-extractable P-256 keypair -- used both for a session key
 * (`../api/auth.ts`'s `signIn`, one per sign-in, never stored beyond the
 * session) and for an account key (`../api/enrolment.ts`'s
 * `redeemAccountEnrolment`, one per invitation redeemed, stored under the
 * address it was issued to). */
export async function generateKeyPair(): Promise<CryptoKeyPair> {
  const pair = await crypto.subtle.generateKey(ECDSA_P256, false, ['sign', 'verify']);
  return pair as CryptoKeyPair;
}

/** SEC1 uncompressed point (`0x04 || X || Y`, 65 bytes) -- the same shape
 * `authority::PUBLIC_KEY_LEN` names and `account_keys.public_key` stores. */
export async function exportPublicKeyRaw(publicKey: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey('raw', publicKey);
  return new Uint8Array(raw);
}

/** Sign `message` and normalise `s` low, matching `SoftwareKey::sign`. */
export async function signMessage(privateKey: CryptoKey, message: Uint8Array): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign(SIGN_ALG, privateKey, message as BufferSource);
  return normalizeLowS(new Uint8Array(signature));
}

// ---------------------------------------------------------------------------
// The account key stores -- two slots per address, one database
// ---------------------------------------------------------------------------
//
// Two object stores in the one database, rather than a keyed prefix inside
// a single store: the promotion `redeemAccountEnrolment` needs on a
// definite OK answer (delete the pending entry, write the enrolled one) can
// then run as one IndexedDB transaction spanning both stores, which is
// atomic by the platform's own guarantee -- a prefix scheme sharing one
// store would still need two writes with no transaction covering both any
// more cheaply, for a key format `getEnrolledKeyPair`'s existing callers
// would also have had to learn.
//
// - STORE_PENDING: written *before* the network call that spends an
//   invitation token, so a keypair exists locally before anything is
//   spent server-side. Left in place on any outcome this browser cannot
//   read as a definite refusal -- see `../api/enrolment.ts`.
// - STORE_ENROLLED: the key this browser actually signs in with. Written
//   only by promotion, never directly by `redeemAccountEnrolment`.

const DB_NAME = 'fathom-enrolled-keys';
const STORE_ENROLLED = 'keys';
const STORE_PENDING = 'pending';
const DB_VERSION = 2;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_ENROLLED)) {
        db.createObjectStore(STORE_ENROLLED);
      }
      if (!db.objectStoreNames.contains(STORE_PENDING)) {
        db.createObjectStore(STORE_PENDING);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error as Error);
  });
}

function getFromStore(db: IDBDatabase, store: string, address: string): Promise<CryptoKeyPair | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const request = tx.objectStore(store).get(address);
    request.onsuccess = () => resolve((request.result as CryptoKeyPair | undefined) ?? null);
    request.onerror = () => reject(request.error as Error);
  });
}

function putInStore(db: IDBDatabase, store: string, address: string, pair: CryptoKeyPair): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(pair, address);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error as Error);
  });
}

function deleteFromStore(db: IDBDatabase, store: string, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(address);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error as Error);
  });
}

/** The account's enrolled keypair for `address`, or `null` if this browser
 * holds none. */
export async function getEnrolledKeyPair(address: string): Promise<CryptoKeyPair | null> {
  const db = await openDb();
  try {
    return await getFromStore(db, STORE_ENROLLED, address);
  } finally {
    db.close();
  }
}

/** Write `pair` directly into the enrolled slot for `address`, replacing
 * whatever was there. Used by promotion (`promotePendingKeyPair`) and kept
 * exported for manual testing from the console; `redeemAccountEnrolment`
 * itself never calls this directly -- it writes the pending slot and lets
 * promotion move it across. */
export async function putEnrolledKeyPair(address: string, pair: CryptoKeyPair): Promise<void> {
  const db = await openDb();
  try {
    await putInStore(db, STORE_ENROLLED, address, pair);
  } finally {
    db.close();
  }
}

/** The pending keypair for `address`, or `null` if this browser holds none.
 * A pending entry means this browser generated a keypair and, at some
 * point, sent it toward the server -- it does not mean the server accepted
 * it. See `../api/enrolment.ts`. */
export async function getPendingKeyPair(address: string): Promise<CryptoKeyPair | null> {
  const db = await openDb();
  try {
    return await getFromStore(db, STORE_PENDING, address);
  } finally {
    db.close();
  }
}

/** Write `pair` into the pending slot for `address`, *before* the network
 * call that would spend an invitation token against it. If this throws,
 * the caller must not proceed to that network call -- nothing has been
 * spent yet, so there is nothing to leave the record straight about. */
export async function putPendingKeyPair(address: string, pair: CryptoKeyPair): Promise<void> {
  const db = await openDb();
  try {
    await putInStore(db, STORE_PENDING, address, pair);
  } finally {
    db.close();
  }
}

/** Delete the pending slot for `address` without touching the enrolled
 * slot. Called only once a refusal has been read off an actual HTTP
 * response -- a definite "the server did not enrol this key". */
export async function deletePendingKeyPair(address: string): Promise<void> {
  const db = await openDb();
  try {
    await deleteFromStore(db, STORE_PENDING, address);
  } finally {
    db.close();
  }
}

/**
 * Move the pending keypair for `address` into the enrolled slot, replacing
 * any key already enrolled there, and remove the pending entry -- one
 * IndexedDB transaction spanning both stores, so a reader never observes a
 * moment with the key in neither or in both. If no pending entry exists,
 * this resolves without changing anything (promotion is idempotent, since
 * both `redeemAccountEnrolment` and `signIn` may call it after already
 * having their own copy of the pair in memory).
 *
 * `enrolledAs` is the enrolled slot's key when it differs from the pending
 * one: an operator's key waits under `OPERATOR_PENDING_SLOT` until the
 * server's answer names the operator (`../api/constants.ts`), and is filed
 * under that id here. Every account promotion leaves it at its default.
 */
export async function promotePendingKeyPair(address: string, enrolledAs: string = address): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_PENDING, STORE_ENROLLED], 'readwrite');
      const pendingStore = tx.objectStore(STORE_PENDING);
      const enrolledStore = tx.objectStore(STORE_ENROLLED);
      const getRequest = pendingStore.get(address);
      getRequest.onsuccess = () => {
        const pair = getRequest.result as CryptoKeyPair | undefined;
        if (pair) {
          enrolledStore.put(pair, enrolledAs);
          pendingStore.delete(address);
        }
      };
      getRequest.onerror = () => reject(getRequest.error as Error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error as Error);
    });
  } finally {
    db.close();
  }
}
