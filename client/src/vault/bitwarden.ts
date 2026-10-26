// Opening a Vaultwarden (Bitwarden-compatible) account's keys in the browser, once, when an admin
// connects Fathom's own account to one collection (ADR-0071, external vaults; card r32-external).
// Everything here is WebCrypto: PBKDF2, HMAC, AES-CBC and RSA-OAEP are the browser's own,
// constant-time implementations, so no RSA code of Fathom's own is ever involved.
//
// Sources, read 2026-10-25 (CLAUDE.md rule 1):
// - bitwarden/sdk-internal at 5cf9198 (2026-10-23), `crates/bitwarden-crypto`:
//   `keys/kdf.rs` (PBKDF2-SHA256 over the password, salt = the e-mail trimmed and lower-cased,
//   32 bytes; Argon2id salts with SHA-256 of the e-mail), `keys/utils.rs` (`stretch_key`:
//   HKDF-Expand, SHA-256, info "enc" and "mac", 32 bytes each), `symmetric_crypto_key.rs` (a
//   64-byte key is `enc_key || mac_key`), `hazmat/symmetric_encryption/aes256_cbc_hmac_sha256_ae.rs`
//   (MAC = HMAC-SHA256(mac_key, iv || ciphertext)), and `enc_string/*.rs` ("2.iv|ct|mac",
//   "4.data" for RSA-2048-OAEP-SHA1).
// - bitwarden/server `src/Core/Enums/EncryptionType.cs` (type 2 AesCbc256_HmacSha256_B64, type 4
//   Rsa2048_OaepSha1_B64).
// - dani-garcia/vaultwarden at 0f44744 (2026-10-25): no COSE (type 7) keys in its user model, so
//   types 2 and 4 are all a Vaultwarden account holds.
//
// Argon2id accounts are refused for now, in words: the engine's Argon2 takes the vault's own
// shape (a secret input, 16-byte salt) and Bitwarden's is different. Fathom's account is one an
// admin makes for it, and PBKDF2 is Bitwarden's default for it.

import { concatBytes, utf8 } from '../crypto/bytes';

export type BitwardenKdf = { type: 'pbkdf2'; iterations: number } | { type: 'argon2id'; iterations: number; memoryMiB: number; parallelism: number };

/** sdk-internal `PBKDF2_MIN_ITERATIONS`. */
export const PBKDF2_MIN_ITERATIONS = 5000;

const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const buf = (b: Uint8Array): BufferSource => b as BufferSource;

/** A 64-byte Bitwarden key: AES-256 key, then HMAC key. */
export interface CbcHmacKey {
  enc: Uint8Array;
  mac: Uint8Array;
}

export function splitKey(key64: Uint8Array): CbcHmacKey {
  if (key64.length !== 64) throw new Error('A Bitwarden key is 64 bytes.');
  return { enc: key64.slice(0, 32), mac: key64.slice(32) };
}

/** The master key: PBKDF2-SHA256(password, lower-cased trimmed e-mail). */
export async function masterKey(password: string, email: string, kdf: BitwardenKdf): Promise<Uint8Array> {
  if (kdf.type !== 'pbkdf2') {
    throw new Error('This account uses Argon2id. For now Fathom opens accounts that use PBKDF2, Bitwarden’s default: make Fathom’s account with that.');
  }
  if (kdf.iterations < PBKDF2_MIN_ITERATIONS) throw new Error('This account’s key derivation is weaker than Bitwarden allows.');
  const base = await crypto.subtle.importKey('raw', buf(utf8(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: buf(utf8(email.trim().toLowerCase())), iterations: kdf.iterations },
    base,
    256,
  );
  return new Uint8Array(bits);
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', buf(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, buf(data)));
}

/** HKDF-Expand alone (RFC 5869 §2.3), one block: the master key is already uniform, and
 * Bitwarden expands it without an extract step. */
async function hkdfExpand32(prk: Uint8Array, info: string): Promise<Uint8Array> {
  return hmac(prk, concatBytes(utf8(info), new Uint8Array([1])));
}

/** `stretch_key`: the 64-byte key a master key protects the user key with. */
export async function stretch(master: Uint8Array): Promise<CbcHmacKey> {
  return { enc: await hkdfExpand32(master, 'enc'), mac: await hkdfExpand32(master, 'mac') };
}

export type EncString = { type: 2; iv: Uint8Array; data: Uint8Array; mac: Uint8Array } | { type: 4; data: Uint8Array };

export function parseEncString(s: string): EncString {
  const dot = s.indexOf('.');
  const type = Number(s.slice(0, dot));
  const parts = s.slice(dot + 1).split('|');
  if (type === 2 && parts.length === 3) {
    const [iv, data, mac] = parts.map(b64);
    if (iv.length !== 16 || mac.length !== 32) throw new Error('A type-2 value has a 16-byte IV and a 32-byte MAC.');
    return { type: 2, iv, data, mac };
  }
  if (type === 4 && parts.length === 1) return { type: 4, data: b64(parts[0]) };
  throw new Error(`Fathom opens type 2 and type 4 values only; this is type ${Number.isFinite(type) ? type : 'unknown'}.`);
}

/** Type 2: check the MAC over IV ‖ ciphertext first (WebCrypto's verify compares in constant
 * time), then AES-256-CBC. A wrong key is a MAC failure, never a padding oracle. */
export async function decryptType2(value: string | EncString, key: CbcHmacKey): Promise<Uint8Array> {
  const e = typeof value === 'string' ? parseEncString(value) : value;
  if (e.type !== 2) throw new Error('Expected a type-2 value.');
  const mk = await crypto.subtle.importKey('raw', buf(key.mac), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  if (!(await crypto.subtle.verify('HMAC', mk, buf(e.mac), buf(concatBytes(e.iv, e.data))))) {
    throw new Error('That did not open: the password is wrong, or the value is not this key’s.');
  }
  const ek = await crypto.subtle.importKey('raw', buf(key.enc), 'AES-CBC', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: buf(e.iv) }, ek, buf(e.data)));
}

/** Type 4: RSA-2048-OAEP-SHA1 under the account's private key (PKCS#8 DER). */
export async function decryptType4(value: string | EncString, privateKeyDer: Uint8Array): Promise<Uint8Array> {
  const e = typeof value === 'string' ? parseEncString(value) : value;
  if (e.type !== 4) throw new Error('Expected a type-4 value.');
  const k = await crypto.subtle.importKey('pkcs8', buf(privateKeyDer), { name: 'RSA-OAEP', hash: 'SHA-1' }, false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, k, buf(e.data)));
}

/** What an admin's browser opens to connect one collection: the account's user key from its
 * password, its private key, and from that the organisation key the collection is under. Only
 * the organisation key leaves this function; Fathom's server is given it, sealed, and never the
 * password, the user key or the private key. */
export async function openOrganisationKey(
  password: string,
  email: string,
  kdf: BitwardenKdf,
  protectedUserKey: string,
  protectedPrivateKey: string,
  protectedOrganisationKey: string,
): Promise<Uint8Array> {
  const user = splitKey(await decryptType2(protectedUserKey, await stretch(await masterKey(password, email, kdf))));
  const der = await decryptType2(protectedPrivateKey, user);
  const org = await decryptType4(protectedOrganisationKey, der);
  if (org.length !== 64) throw new Error('The organisation key is not a 64-byte Bitwarden key.');
  return org;
}
