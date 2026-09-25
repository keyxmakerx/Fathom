// Builds and signs the organisation claim. The root private key never appears
// in a network call; the person keeps it as the recovery key.

import { concatBytes, lp, readLp, u32LE, u64LE, utf8 } from '../crypto/bytes';
import { signMessage } from '../crypto/keys';
import { encodeUlid } from '../document/ulid';
import { signedFetch } from './signedFetch';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, the same alphabet the server's own TOTP setup key
 * uses (`api/credentials.ts`'s `secretBase32`). */
function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/** ADR-0057 decision 5's recovery key: `scalar` in base32, groups of four,
 * plus a trailing checksum group of `SHA-256(scalar)`'s first four. */
export async function formatRecoveryKey(scalar: Uint8Array): Promise<string> {
  const body = base32Encode(scalar);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', scalar as BufferSource));
  const checksum = base32Encode(digest).slice(0, 4);
  const groups: string[] = [];
  for (let i = 0; i < body.length; i += 4) groups.push(body.slice(i, i + 4));
  groups.push(checksum);
  return groups.join('-');
}

/** 16 bytes from the browser's CSPRNG -- `authority::derive_organisation_id`'s
 * `id_salt`, generated fresh for every claim. */
export function randomIdSalt(): Uint8Array {
  const out = new Uint8Array(16);
  crypto.getRandomValues(out);
  return out;
}

/** `authority::TAG_KEY_FPR` and `authority::key_fingerprint`:
 * `H(LP("fathom/key/fpr/v1") ‖ LP(public_key))`. */
export async function keyFingerprint(publicKey: Uint8Array): Promise<Uint8Array> {
  const message = concatBytes(lp(utf8('fathom/key/fpr/v1')), lp(publicKey));
  return new Uint8Array(await crypto.subtle.digest('SHA-256', message as BufferSource));
}

/** `authority::TAG_ORG_ID` and `authority::derive_organisation_id`: the first
 * 16 bytes of `H(LP("fathom/org/id/v1") ‖ LP(root_pubkey) ‖ LP(id_salt))`. */
export async function deriveOrganisationId(rootPubkey: Uint8Array, idSalt: Uint8Array): Promise<string> {
  const message = concatBytes(lp(utf8('fathom/org/id/v1')), lp(rootPubkey), lp(idSalt));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', message as BufferSource));
  let value = 0n;
  for (let i = 0; i < 16; i += 1) {
    value = (value << 8n) | BigInt(digest[i]);
  }
  return encodeUlid(value);
}

/** `authority::GrantFacts` for the one shape this client signs: a root-signed
 * genesis steward grant, organisation-wide. */
export interface GenesisGrantFacts {
  organisation: string;
  rootPubkeyFpr: Uint8Array;
  subject: string;
  subjectKeyFpr: Uint8Array;
  effectiveFromUnix: number;
  expiresAtUnix: number;
}

/** `authority::TAG_GRANT` and `authority::grant_bytes`, byte for byte. */
export function grantBytes(facts: GenesisGrantFacts): Uint8Array {
  return concatBytes(
    lp(utf8('fathom/grant/v2')),
    lp(utf8(facts.organisation)),
    lp(facts.rootPubkeyFpr),
    lp(utf8('')), // scope: empty -- a steward grant is organisation-wide
    lp(utf8(facts.subject)),
    lp(facts.subjectKeyFpr),
    lp(utf8('steward')),
    lp(utf8('')), // granter: empty -- root-signed (§3.3's LP(granter_id_or_empty))
    lp(facts.rootPubkeyFpr), // granter_key_fpr: the root key signs for itself
    u64LE(facts.effectiveFromUnix),
    u64LE(facts.expiresAtUnix),
    u32LE(0), // sole_steward_appointment: false -- genesis needs no seconding
    u32LE(1), // auth_epoch: always 1 for a genesis grant
  );
}

/**
 * Sign one genesis grant with the organisation's root private key, for the
 * account named by `subject` and its enrolled key `subjectPubkey`.
 */
export async function signGenesisGrant(
  rootPrivateKey: CryptoKey,
  rootPubkey: Uint8Array,
  idSalt: Uint8Array,
  subject: string,
  subjectPubkey: Uint8Array,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ organisation: string; effectiveFromUnix: number; expiresAtUnix: number; signature: Uint8Array }> {
  const organisation = await deriveOrganisationId(rootPubkey, idSalt);
  const rootPubkeyFpr = await keyFingerprint(rootPubkey);
  const subjectKeyFpr = await keyFingerprint(subjectPubkey);
  const effectiveFromUnix = now;
  const expiresAtUnix = now + 365 * 24 * 3600;
  const message = grantBytes({
    organisation,
    rootPubkeyFpr,
    subject,
    subjectKeyFpr,
    effectiveFromUnix,
    expiresAtUnix,
  });
  const signature = await signMessage(rootPrivateKey, message);
  return { organisation, effectiveFromUnix, expiresAtUnix, signature };
}

/** `POST /enrolment/organisation`'s body, LP-framed field by field, as this function builds it. */
export function buildClaimBody(
  token: Uint8Array,
  noticeAddress: string,
  rootPubkey: Uint8Array,
  idSalt: Uint8Array,
  subject: string,
  subjectPubkey: Uint8Array,
  effectiveFromUnix: number,
  expiresAtUnix: number,
  signature: Uint8Array,
): Uint8Array {
  return concatBytes(
    lp(token),
    lp(utf8(noticeAddress)),
    lp(rootPubkey),
    lp(idSalt),
    lp(utf8(subject)),
    lp(subjectPubkey),
    lp(utf8(String(effectiveFromUnix))),
    lp(utf8(String(expiresAtUnix))),
    lp(signature),
  );
}

/** `redeem_organisation_claim_handler`'s answer: `LP(organisation_id)`. */
export function parseClaimAnswer(bytes: Uint8Array): string {
  const { value, rest } = readLp(bytes);
  if (rest.length !== 0) {
    throw new Error(`malformed organisation claim answer: ${rest.length} trailing byte(s)`);
  }
  return new TextDecoder().decode(value);
}

/**
 * Signs the grant and sends the request. Takes the root keypair rather than
 * generating one, so the caller decides what happens to the private half next.
 */
export async function redeemOrganisationClaim(
  token: Uint8Array,
  noticeAddress: string,
  rootKeyPair: CryptoKeyPair,
  rootPubkey: Uint8Array,
  idSalt: Uint8Array,
  subject: string,
  subjectPubkey: Uint8Array,
): Promise<string> {
  const grant = await signGenesisGrant(rootKeyPair.privateKey, rootPubkey, idSalt, subject, subjectPubkey);
  const body = buildClaimBody(
    token,
    noticeAddress,
    rootPubkey,
    idSalt,
    subject,
    subjectPubkey,
    grant.effectiveFromUnix,
    grant.expiresAtUnix,
    grant.signature,
  );
  const bytes = await signedFetch('POST', '/enrolment/organisation', body);
  return parseClaimAnswer(bytes);
}
