// Everything the vault does with keys, in the browser, with WebCrypto and the engine's Argon2id.
// No function here sends anything: `../api/vault.ts` sends what these produce. The server never
// receives a key that opens a password (ADR-0042 Mode A); what it gets is sealed here.
//
// Four kinds of key, and what protects each:
//
// - **The unlock key**, Argon2id(passphrase, salt, secret = the 128-bit vault key on the
//   Emergency Kit), ADR-0043 §6. Never stored; derived at unlock and dropped at lock.
// - **A person's vault key**, an ECDH P-256 pair. The private scalar is sealed under the unlock
//   key with AES-256-GCM before it is sent. Unsealed, it is imported non-extractable.
// - **The recovery key**, the same shape, sealed under a key derived from the 256-bit secret
//   printed on the organisation's recovery sheet. Admins only.
// - **A login's content key**, 32 random bytes per epoch. It seals the login's secret, and is
//   wrapped to each holder's vault key by §13.7's ECDH + HKDF + AES-GCM.

import { concatBytes, lp, readLp, utf8 } from '../crypto/bytes';
import type { Engine } from '../engine/engine';
import { sealAad, secretAad, wrapInfo } from './bytes';

/** Argon2id settings for a new vault key. Above both references read 2026-10-25: OWASP's
 * Password Storage Cheat Sheet lists m=19456 KiB, t=2, p=1 as a minimum equivalent to its others,
 * and Bitwarden's KDF page gives 32 MiB, 6 passes, 4 lanes as its default. The server and the
 * module both refuse anything below 19456 KiB or 2 passes. Stored per key, so raising these later
 * changes new keys only. */
export const KDF = { m: 65_536, t: 3, p: 1 } as const;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ECDH: EcKeyImportParams = { name: 'ECDH', namedCurve: 'P-256' };
const AES = 'AES-GCM';

function random(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

// ---------------------------------------------------------------------------
// Text forms people read and type
// ---------------------------------------------------------------------------

/** Bytes as Crockford base32, upper case, most significant bit first. */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

/** The reverse, forgiving what people do when they copy a code by hand: case, spaces and
 * dashes, and the letters Crockford maps to digits (O to 0, I and L to 1). */
export function fromBase32(text: string, length: number): Uint8Array | null {
  const clean = text.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (clean.length !== Math.ceil((length * 8) / 5)) return null;
  const out = new Uint8Array(length);
  let bits = 0;
  let value = 0;
  let i = 0;
  for (const ch of clean) {
    const digit = CROCKFORD.indexOf(ch);
    if (digit < 0) return null;
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      if (i < length) out[i] = (value >>> (bits - 8)) & 255;
      i += 1;
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  // The padding bits of the last character must be zero, or this was mistyped.
  if (value !== 0) return null;
  return out;
}

function grouped(text: string, size: number): string {
  return text.match(new RegExp(`.{1,${size}}`, 'g'))?.join('-') ?? '';
}

/** The 128-bit vault key as printed on the Emergency Kit: 26 characters in groups of 5 (the last
 * group has 6). Typed once per new browser. */
export function vaultKeyText(secret: Uint8Array): string {
  const t = base32(secret);
  return `${grouped(t.slice(0, 20), 5)}-${t.slice(20)}`;
}

/** The recovery sheet's 256-bit secret: 52 characters in groups of 4. */
export function recoveryText(secret: Uint8Array): string {
  return grouped(base32(secret), 4);
}

/** A vault key fingerprint for people to compare: the first 120 bits as 24 characters in four
 * groups of 6. Storage design §13.2 asked for nine words; this is the same strength in a form a
 * network engineer reads aloud without a word list, and ADR-0071 records the change. */
export function fingerprintText(fpr: Uint8Array): string {
  return grouped(base32(fpr.slice(0, 15)), 6);
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** A vault private key, opened and ready, plus its public half. Not extractable. */
export interface OpenVaultKey {
  privateKey: CryptoKey;
  publicKey: Uint8Array;
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(text: string): Uint8Array {
  const b = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  return Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
}

function pointToJwk(publicKey: Uint8Array): JsonWebKey {
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error('a vault public key is a 65-byte uncompressed point');
  return { kty: 'EC', crv: 'P-256', x: b64url(publicKey.slice(1, 33)), y: b64url(publicKey.slice(33)) };
}

async function importPrivate(publicKey: Uint8Array, scalar: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', { ...pointToJwk(publicKey), d: b64url(scalar) }, ECDH, false, ['deriveBits']);
}

async function importPublic(publicKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', publicKey as BufferSource, ECDH, false, []);
}

/** A fresh ECDH pair: its public point and raw private scalar. The scalar exists only long enough
 * to be sealed and re-imported non-extractable. */
async function freshPair(): Promise<{ publicKey: Uint8Array; scalar: Uint8Array }> {
  const pair = (await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  if (!jwk.d) throw new Error('this browser did not export the new key');
  return { publicKey, scalar: unb64url(jwk.d) };
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, AES, false, ['encrypt', 'decrypt']);
}

async function seal(key: CryptoKey, plain: Uint8Array, aad: Uint8Array): Promise<{ ct: Uint8Array; nonce: Uint8Array }> {
  const nonce = random(12);
  const ct = await crypto.subtle.encrypt({ name: AES, iv: nonce as BufferSource, additionalData: aad as BufferSource }, key, plain as BufferSource);
  return { ct: new Uint8Array(ct), nonce };
}

/** Thrown when a passphrase, a kit or a sheet does not open what it should. Says nothing more,
 * because there is nothing more that can be known. */
export class WrongSecret extends Error {
  constructor() {
    super('That does not open it. Check the passphrase and the vault key on your Emergency Kit.');
  }
}

async function open(key: CryptoKey, ct: Uint8Array, nonce: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  try {
    const plain = await crypto.subtle.decrypt({ name: AES, iv: nonce as BufferSource, additionalData: aad as BufferSource }, key, ct as BufferSource);
    return new Uint8Array(plain);
  } catch {
    throw new WrongSecret();
  }
}

export interface SealedKey {
  publicKey: Uint8Array;
  sealedPrivate: Uint8Array;
  sealedNonce: Uint8Array;
}

export interface PersonKeyMade extends SealedKey {
  kdfSalt: Uint8Array;
  /** The 128-bit vault key. Shown once on the Emergency Kit and kept in this browser. */
  secret: Uint8Array;
  opened: OpenVaultKey;
}

/** The unlock key for a person's vault key. */
export async function unlockKey(engine: Engine, passphrase: string, salt: Uint8Array, secret: Uint8Array, m: number, t: number, p: number): Promise<CryptoKey> {
  return aesKey(engine.vaultKdf(utf8(passphrase.normalize('NFC')), salt, secret, m, t, p));
}

/** A new 128-bit vault key, for the Emergency Kit. Made before the passphrase is chosen, so the
 * kit is saved first. */
export function newVaultSecret(): Uint8Array {
  return random(16);
}

/** Make a person's vault key, sealed under their passphrase and the vault key `secret`. */
export async function makePersonKey(engine: Engine, organisation: string, account: string, passphrase: string, secret: Uint8Array): Promise<PersonKeyMade> {
  const kdfSalt = random(16);
  const { publicKey, scalar } = await freshPair();
  const key = await unlockKey(engine, passphrase, kdfSalt, secret, KDF.m, KDF.t, KDF.p);
  const { ct, nonce } = await seal(key, scalar, sealAad('person', organisation, account, publicKey));
  const opened = { privateKey: await importPrivate(publicKey, scalar), publicKey };
  scalar.fill(0);
  return { publicKey, sealedPrivate: ct, sealedNonce: nonce, kdfSalt, secret, opened };
}

/** Open a person's vault key. Throws `WrongSecret` for a wrong passphrase or kit. */
export async function openPersonKey(
  engine: Engine,
  organisation: string,
  account: string,
  sealed: SealedKey & { kdfSalt: Uint8Array; m: number; t: number; p: number },
  passphrase: string,
  secret: Uint8Array,
): Promise<OpenVaultKey> {
  const key = await unlockKey(engine, passphrase, sealed.kdfSalt, secret, sealed.m, sealed.t, sealed.p);
  const scalar = await open(key, sealed.sealedPrivate, sealed.sealedNonce, sealAad('person', organisation, account, sealed.publicKey));
  try {
    return { privateKey: await importPrivate(sealed.publicKey, scalar), publicKey: sealed.publicKey };
  } finally {
    scalar.fill(0);
  }
}

async function sheetKey(sheetSecret: Uint8Array): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', sheetSecret as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8('fathom/vault/recovery/sheet/v1') as BufferSource },
    ikm,
    256,
  );
  return aesKey(new Uint8Array(bits));
}

/** Make the organisation's recovery key. The secret goes on the printed sheet and nowhere else. */
export async function makeRecoveryKey(organisation: string, createdBy: string): Promise<SealedKey & { sheetSecret: Uint8Array }> {
  const sheetSecret = random(32);
  const { publicKey, scalar } = await freshPair();
  const { ct, nonce } = await seal(await sheetKey(sheetSecret), scalar, sealAad('recovery', organisation, createdBy, publicKey));
  scalar.fill(0);
  return { publicKey, sealedPrivate: ct, sealedNonce: nonce, sheetSecret };
}

export async function openRecoveryKey(organisation: string, createdBy: string, sealed: SealedKey, sheetSecret: Uint8Array): Promise<OpenVaultKey> {
  const scalar = await open(await sheetKey(sheetSecret), sealed.sealedPrivate, sealed.sealedNonce, sealAad('recovery', organisation, createdBy, sealed.publicKey));
  try {
    return { privateKey: await importPrivate(sealed.publicKey, scalar), publicKey: sealed.publicKey };
  } finally {
    scalar.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Wraps (§13.7) and the login's secret
// ---------------------------------------------------------------------------

export interface WrapContext {
  organisation: string;
  credential: string;
  epoch: number;
  sharerKeyFpr: Uint8Array;
}

async function kek(z: ArrayBuffer, info: Uint8Array): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', z, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: info as BufferSource }, ikm, 256);
  return aesKey(new Uint8Array(bits));
}

/** Wrap a content key to one recipient: `LP(eph_pub) ‖ LP(nonce) ‖ LP(ct)`, 137 bytes. */
export async function wrapTo(ctx: WrapContext, recipientPublicKey: Uint8Array, recipientKeyFpr: Uint8Array, contentKey: Uint8Array): Promise<Uint8Array> {
  const eph = (await crypto.subtle.generateKey(ECDH, false, ['deriveBits'])) as CryptoKeyPair;
  const ephPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const z = await crypto.subtle.deriveBits({ name: 'ECDH', public: await importPublic(recipientPublicKey) }, eph.privateKey, 256);
  const info = wrapInfo(ctx.organisation, ctx.credential, ctx.epoch, ctx.sharerKeyFpr, recipientKeyFpr, ephPub);
  const { ct, nonce } = await seal(await kek(z, info), contentKey, info);
  return concatBytes(lp(ephPub), lp(nonce), lp(ct));
}

/** Open a wrap made to `me`. The caller has already checked the signed share covers it. */
export async function unwrap(ctx: WrapContext, me: OpenVaultKey, myKeyFpr: Uint8Array, wrap: Uint8Array): Promise<Uint8Array> {
  const misshapen = () => new Error('That copy of the login is not shaped like one Fathom makes, so it was not opened.');
  let a, b, c;
  try {
    a = readLp(wrap);
    b = readLp(a.rest);
    c = readLp(b.rest);
  } catch {
    throw misshapen();
  }
  if (c.rest.length !== 0 || a.value.length !== 65 || b.value.length !== 12 || c.value.length !== 48) throw misshapen();
  const z = await crypto.subtle.deriveBits({ name: 'ECDH', public: await importPublic(a.value) }, me.privateKey, 256);
  const info = wrapInfo(ctx.organisation, ctx.credential, ctx.epoch, ctx.sharerKeyFpr, myKeyFpr, a.value);
  return open(await kek(z, info), c.value, b.value, info);
}

/** What one login holds. Sealed whole; the server sees its length and nothing else. */
export interface Secret {
  username: string;
  password: string;
  note: string;
}

export const MAX_SECRET_BYTES = 8_192;

export function newContentKey(): Uint8Array {
  return random(32);
}

export async function sealSecret(organisation: string, credential: string, epoch: number, contentKey: Uint8Array, secret: Secret): Promise<{ ct: Uint8Array; nonce: Uint8Array }> {
  const plain = utf8(JSON.stringify({ u: secret.username, p: secret.password, n: secret.note }));
  if (plain.length + 16 > MAX_SECRET_BYTES) throw new Error('That is too long to store. Keep the note shorter.');
  return seal(await aesKey(contentKey), plain, secretAad(organisation, credential, epoch));
}

export async function openSecret(organisation: string, credential: string, epoch: number, contentKey: Uint8Array, ct: Uint8Array, nonce: Uint8Array): Promise<Secret> {
  const plain = await open(await aesKey(contentKey), ct, nonce, secretAad(organisation, credential, epoch));
  const parsed = JSON.parse(new TextDecoder().decode(plain)) as { u?: unknown; p?: unknown; n?: unknown };
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  return { username: s(parsed.u), password: s(parsed.p), note: s(parsed.n) };
}

/** Verify an ES256 signature by an account key. */
export async function verifyAccountSignature(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', publicKey as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature as BufferSource, message as BufferSource);
  } catch {
    return false;
  }
}

