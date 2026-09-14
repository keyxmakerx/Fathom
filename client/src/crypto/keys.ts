// The two keypairs a sign-in touches, kept in one small module so nothing
// else in this client has its own idea of how either is produced or stored.
//
// 1. The SESSION keypair -- fresh every sign-in, P-256, generated here with
//    `extractable: false` on the private half. It never leaves the browser
//    and is never serialised; only its public half (SEC1 uncompressed,
//    exported once) and signatures made with it ever go over the wire. It
//    signs every request for the life of the session (12h --
//    `sessions::SESSION_LIFETIME`).
//
// 2. The ENROLLED (account) keypair -- long-lived, proves who the session
//    belongs to by signing the sign-in challenge once. **This build has no
//    enrolment surface.** `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` puts
//    enrolment behind an invitation flow through an admin console that does
//    not exist yet, so nothing in this client can create one of these keys.
//    `getEnrolledKeyPair` only reads what a future enrolment screen would
//    have written into this browser's own IndexedDB; `putEnrolledKeyPair`
//    exists for that future screen and for a developer to call by hand from
//    the console while testing against a database seeded some other way.
//    Nothing in this codebase calls it yet -- see `SignIn.tsx`.

import { normalizeLowS } from './p256';

const ECDSA_P256: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_ALG: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' };

/** A fresh, non-extractable P-256 keypair for one session. */
export async function generateSessionKeyPair(): Promise<CryptoKeyPair> {
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
// The enrolled key store -- read-only from this slice's point of view
// ---------------------------------------------------------------------------

const DB_NAME = 'fathom-enrolled-keys';
const STORE_NAME = 'keys';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error as Error);
  });
}

/** The account's enrolled keypair for `address`, or `null` if this browser
 * holds none -- which, absent any enrolment screen, is every browser today. */
export async function getEnrolledKeyPair(address: string): Promise<CryptoKeyPair | null> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(address);
      request.onsuccess = () => resolve((request.result as CryptoKeyPair | undefined) ?? null);
      request.onerror = () => reject(request.error as Error);
    });
  } finally {
    db.close();
  }
}

/** Not called from anywhere in this slice. Kept for the enrolment screen
 * this build does not have, and for manual testing from the console. */
export async function putEnrolledKeyPair(address: string, pair: CryptoKeyPair): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(pair, address);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error as Error);
    });
  } finally {
    db.close();
  }
}
