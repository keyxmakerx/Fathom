// The bytes a steward signs, built here from what the steward saw, so the key
// never signs bytes the server merely asserts. Each function mirrors one in
// `crates/fathom-server/src/authority.rs`; `grantBytes.test.ts` holds vectors
// that `tests/authority_vectors.rs` checks against the Rust.

import { concatBytes, lp, u32LE, u64LE, utf8 } from '../crypto/bytes';

export type GrantCapability = 'read' | 'draw' | 'steward';

/** Everything `authority::grant_bytes` covers. `scope` is `''` for the organisation. */
export interface GrantFacts {
  organisation: string;
  rootPubkeyFpr: Uint8Array;
  scope: string;
  subject: string;
  subjectKeyFpr: Uint8Array;
  capability: GrantCapability;
  granter: string;
  granterKeyFpr: Uint8Array;
  effectiveFromUnix: number;
  /** 0 for read and draw: they do not expire. */
  expiresAtUnix: number;
  /** A sole-steward appointment: live after 24 hours, never seconded. */
  soleSteward: boolean;
  authEpoch: number;
}

/** `authority::grant_bytes`. */
export function grantBytes(f: GrantFacts): Uint8Array {
  return concatBytes(
    lp(utf8('fathom/grant/v2')),
    lp(utf8(f.organisation)),
    lp(f.rootPubkeyFpr),
    lp(utf8(f.scope)),
    lp(utf8(f.subject)),
    lp(f.subjectKeyFpr),
    lp(utf8(f.capability)),
    lp(utf8(f.granter)),
    lp(f.granterKeyFpr),
    u64LE(f.effectiveFromUnix),
    u64LE(f.expiresAtUnix),
    u32LE(f.soleSteward ? 1 : 0),
    u32LE(f.authEpoch),
  );
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

/** `authority::second_bytes`: what a second steward signs over a steward grant. */
export async function secondBytes(grant: Uint8Array, granterKeyFpr: Uint8Array): Promise<Uint8Array> {
  return concatBytes(lp(utf8('fathom/grant/second/v1')), lp(await sha256(grant)), lp(granterKeyFpr));
}

/** `authority::key_fingerprint`: the SHA-256 of the tagged public key. */
export async function keyFingerprint(publicKey: Uint8Array): Promise<Uint8Array> {
  return sha256(concatBytes(lp(utf8('fathom/key/fpr/v1')), lp(publicKey)));
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The key-check code: the first 50 bits of a key fingerprint as 10 upper-case
 * Crockford characters, the same on the joiner's screen and the steward's
 * (`invitations::key_code`). It is a check between two people reading two
 * screens, not a defence against a preimage search.
 */
export function keyCode(fingerprint: Uint8Array): string {
  if (fingerprint.length < 8) throw new Error('a fingerprint is 32 bytes');
  let value = 0n;
  for (let i = 0; i < 8; i += 1) value = (value << 8n) | BigInt(fingerprint[i]);
  value >>= 14n;
  let out = '';
  for (let i = 0; i < 10; i += 1) out += CROCKFORD[Number((value >> BigInt(45 - 5 * i)) & 31n)];
  return out;
}

/** The code for a public key, as the person joining reads it out. */
export async function keyCodeOfPublicKey(publicKey: Uint8Array): Promise<string> {
  return keyCode(await keyFingerprint(publicKey));
}

/** Show a code in two halves so it is easy to read aloud: `QDMPW 1FAVF`. */
export function spacedCode(code: string): string {
  return code.length === 10 ? `${code.slice(0, 5)} ${code.slice(5)}` : code;
}
