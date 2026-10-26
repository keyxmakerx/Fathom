// The bytes the vault signs and hashes, built here from what this browser saw, so an account key
// never signs bytes the server merely asserts. Each function mirrors one in
// `crates/fathom-server/src/vault.rs`; `bytes.test.ts` and `tests/vault.rs` pin the same SHA-256
// of each, so the two builders cannot drift apart. Storage design §13.2, §13.3 and §13.7.

import { concatBytes, lp, toHex, u32LE, u64LE, utf8 } from '../crypto/bytes';

/** `vault_alg = 1`: ECDH P-256 + HKDF-SHA256 + AES-256-GCM (§13.7). */
export const VAULT_ALG = 1;
/** The recipient id the recovery sheet takes in a signed set, beside account ids. */
export const RECOVERY_RECIPIENT = 'recovery';

const TAG_KEY = utf8('fathom/vault/pubkey/v1');
const TAG_RECOVERY = utf8('fathom/vault/recovery/v1');
const TAG_FPR = utf8('fathom/vault/key/fpr/v1');
const TAG_SUPERSEDE = utf8('fathom/vault/supersede/v1');
const TAG_SHARE = utf8('fathom/vault/share/v1');
const TAG_WRAP_DIGEST = utf8('fathom/vault/wrap/digest/v1');
const TAG_WRAP = utf8('fathom/vault/wrap/v1');
const TAG_SECRET = utf8('fathom/vault/secret/v1');
const TAG_SEAL_PERSON = utf8('fathom/vault/seal/person/v1');
const TAG_SEAL_RECOVERY = utf8('fathom/vault/seal/recovery/v1');
const TAG_MODE = utf8('fathom/vault/mode/v1');

export function u16LE(n: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, n, true);
  return out;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

/** `vault::key_fpr`: `H("fathom/vault/key/fpr/v1" ‖ LP(vault_pub))`. No length prefix on the
 * tag, as in Rust. */
export function keyFpr(publicKey: Uint8Array): Promise<Uint8Array> {
  return sha256(concatBytes(TAG_FPR, lp(publicKey)));
}

/** `vault::wrap_digest`: `H("fathom/vault/wrap/digest/v1" ‖ LP(wrap))`. */
export function wrapDigest(wrap: Uint8Array): Promise<Uint8Array> {
  return sha256(concatBytes(TAG_WRAP_DIGEST, lp(wrap)));
}

/** `vault::person_key_bytes`, signed by the person's own account key. */
export function personKeyBytes(
  organisation: string,
  account: string,
  publicKey: Uint8Array,
  signerKeyFpr: Uint8Array,
  enrolledAt: number,
): Uint8Array {
  return concatBytes(
    lp(TAG_KEY),
    lp(utf8(organisation)),
    lp(utf8(account)),
    lp(publicKey),
    u16LE(VAULT_ALG),
    lp(signerKeyFpr),
    u64LE(enrolledAt),
  );
}

/** `vault::recovery_key_bytes`, signed by the admin who made the sheet. */
export function recoveryKeyBytes(
  organisation: string,
  publicKey: Uint8Array,
  createdBy: string,
  signerKeyFpr: Uint8Array,
  enrolledAt: number,
): Uint8Array {
  return concatBytes(
    lp(TAG_RECOVERY),
    lp(utf8(organisation)),
    lp(publicKey),
    u16LE(VAULT_ALG),
    lp(utf8(createdBy)),
    lp(signerKeyFpr),
    u64LE(enrolledAt),
  );
}

/** `vault::supersede_bytes`: a replacement key, signed by the replacer's account key. */
export function supersedeBytes(
  organisation: string,
  kind: 'person' | 'recovery',
  subject: string,
  oldFpr: Uint8Array,
  newFpr: Uint8Array,
  at: number,
): Uint8Array {
  return concatBytes(
    lp(TAG_SUPERSEDE),
    lp(utf8(organisation)),
    lp(utf8(kind)),
    lp(utf8(subject)),
    lp(oldFpr),
    lp(newFpr),
    u64LE(at),
  );
}

export interface Recipient {
  /** An account id, or `RECOVERY_RECIPIENT`. */
  who: string;
  keyFpr: Uint8Array;
  digest: Uint8Array;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `vault::canonical_recipients`: `[[who, fpr_hex, digest_hex], ...]` sorted the way Rust's
 * derived `Ord` sorts the struct (who, then fingerprint bytes, then digest bytes), written with
 * no spaces and, like `to_canonical_bytes`, one trailing newline. Ids and hex are plain ASCII,
 * so `JSON.stringify` matches canonical JSON. */
export function canonicalRecipients(recipients: readonly Recipient[]): Uint8Array {
  for (const r of recipients) {
    if (!/^[\x20-\x7e]*$/.test(r.who)) throw new Error('a recipient id must be plain ASCII');
  }
  const sorted = [...recipients].sort(
    (a, b) => compareAscii(a.who, b.who) || compareBytes(a.keyFpr, b.keyFpr) || compareBytes(a.digest, b.digest),
  );
  return utf8(`${JSON.stringify(sorted.map((r) => [r.who, toHex(r.keyFpr), toHex(r.digest)]))}\n`);
}

/** `vault::share_bytes` (§13.3): who holds one login at one epoch, signed by the sharer. */
export function shareBytes(
  organisation: string,
  credential: string,
  epoch: number,
  recipients: readonly Recipient[],
  sharer: string,
  sharerKeyFpr: Uint8Array,
  at: number,
): Uint8Array {
  return concatBytes(
    lp(TAG_SHARE),
    lp(utf8(organisation)),
    lp(utf8(credential)),
    u32LE(epoch),
    lp(canonicalRecipients(recipients)),
    lp(utf8(sharer)),
    lp(sharerKeyFpr),
    u64LE(at),
  );
}

/** §13.7's `wrap_info`: the HKDF info and the AEAD associated data of one wrap. Never sent; both
 * ends rebuild it, so a wrap moved to another recipient or epoch fails to open. */
export function wrapInfo(
  organisation: string,
  credential: string,
  epoch: number,
  sharerKeyFpr: Uint8Array,
  recipientKeyFpr: Uint8Array,
  ephPub: Uint8Array,
): Uint8Array {
  return concatBytes(
    lp(TAG_WRAP),
    lp(utf8(organisation)),
    lp(utf8(credential)),
    u32LE(epoch),
    lp(sharerKeyFpr),
    lp(recipientKeyFpr),
    lp(ephPub),
    u16LE(VAULT_ALG),
  );
}

/** The associated data the secret is sealed under: the login and its epoch. Browser only. */
export function secretAad(organisation: string, credential: string, epoch: number): Uint8Array {
  return concatBytes(lp(TAG_SECRET), lp(utf8(organisation)), lp(utf8(credential)), u32LE(epoch));
}

/** The associated data a vault private key is sealed under: whose key, and which public half. */
export function sealAad(kind: 'person' | 'recovery', organisation: string, subject: string, publicKey: Uint8Array): Uint8Array {
  return concatBytes(
    lp(kind === 'person' ? TAG_SEAL_PERSON : TAG_SEAL_RECOVERY),
    lp(utf8(organisation)),
    lp(utf8(subject)),
    lp(publicKey),
  );
}

/** `vault_fathom::mode_change_bytes` (§13.4): the owner's consent to Fathom keeping a copy it can
 * open (`from` "A", `to` "B"), over the holders of the fresh epoch the change made, the key file
 * the copy will be sealed under, and the share entry it follows. A countersigning admin signs the
 * same bytes, as stored. */
export function modeChangeBytes(
  organisation: string,
  credential: string,
  from: 'A' | 'B',
  to: 'A' | 'B',
  epochBefore: number,
  epochAfter: number,
  owner: string,
  ownerKeyFpr: Uint8Array,
  recipients: readonly Recipient[],
  serverKeyId: string,
  at: number,
  shareSeq: number,
): Uint8Array {
  return concatBytes(
    lp(TAG_MODE),
    lp(utf8(organisation)),
    lp(utf8(credential)),
    lp(utf8(from)),
    lp(utf8(to)),
    u32LE(epochBefore),
    u32LE(epochAfter),
    lp(utf8(owner)),
    lp(ownerKeyFpr),
    lp(canonicalRecipients(recipients)),
    lp(utf8(serverKeyId)),
    u64LE(at),
    u64LE(shareSeq),
  );
}
