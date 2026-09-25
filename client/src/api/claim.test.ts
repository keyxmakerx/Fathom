// Vectors below were produced by an independent Python one-liner (SHA-256,
// struct.pack for length prefixes), not by this module's own encoder.
import { describe, expect, it } from 'vitest';

import { fromHex, toHex } from '../crypto/bytes';
import {
  buildClaimBody,
  deriveOrganisationId,
  formatRecoveryKey,
  grantBytes,
  keyFingerprint,
  parseClaimAnswer,
} from './claim';

const PUBKEY_HEX =
  '040102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40';
const ID_SALT_HEX = '000102030405060708090a0b0c0d0e0f';

describe('keyFingerprint (authority::key_fingerprint)', () => {
  it('hashes LP("fathom/key/fpr/v1") || LP(public_key)', async () => {
    const fpr = await keyFingerprint(fromHex(PUBKEY_HEX));
    expect(toHex(fpr)).toBe('e46a920e9b7ed582155e30703deedd207d1a47d8bc48016d343f8ca7b398be72');
  });
});

describe('deriveOrganisationId (authority::derive_organisation_id)', () => {
  it('encodes the first 16 bytes of the digest as a ULID', async () => {
    const id = await deriveOrganisationId(fromHex(PUBKEY_HEX), fromHex(ID_SALT_HEX));
    expect(id).toBe('0P6CTYDW4HMM864VN21YSXZ9BG');
    expect(id).toHaveLength(26);
  });
});

describe('grantBytes (authority::grant_bytes)', () => {
  it('matches the server byte for byte', async () => {
    const rootPubkeyFpr = await keyFingerprint(fromHex(PUBKEY_HEX));
    const subjectKeyFpr = fromHex('41a1a12d3f86ab29fb657102a9ae1cbd3bd9f06286fabca3ab18679923699747');
    const bytes = grantBytes({
      organisation: '0P6CTYDW4HMM864VN21YSXZ9BG',
      rootPubkeyFpr,
      subject: '01JXACCOUNTIDEXAMPLE000001',
      subjectKeyFpr,
      effectiveFromUnix: 1_790_000_000,
      expiresAtUnix: 1_821_536_000,
    });
    expect(toHex(bytes)).toBe(
      '0f000000666174686f6d2f6772616e742f76321a000000305036435459445734484d4d383634564e32315953585a39424720000000' +
        'e46a920e9b7ed582155e30703deedd207d1a47d8bc48016d343f8ca7b398be72000000001a00000030314a584143434f554e5449' +
        '444558414d504c453030303030312000000041a1a12d3f86ab29fb657102a9ae1cbd3bd9f06286fabca3ab186799236997470700' +
        '0000737465776172640000000020000000e46a920e9b7ed582155e30703deedd207d1a47d8bc48016d343f8ca7b398be72803bb1' +
        '6a00000000006f926c000000000000000001000000',
    );
  });
});

describe('buildClaimBody / parseClaimAnswer', () => {
  it('is nine LP fields in order', () => {
    const body = buildClaimBody(
      new Uint8Array([1, 2, 3]),
      'you@example.test',
      new Uint8Array([4, 5]),
      new Uint8Array([6, 7]),
      '01JXACCOUNTIDEXAMPLE000001',
      new Uint8Array([8, 9]),
      1_790_000_000,
      1_821_536_000,
      new Uint8Array([10, 11]),
    );
    expect(toHex(body)).toBe(
      '0300000001020310000000796f75406578616d706c652e74657374020000000405020000000607' +
        '1a00000030314a584143434f554e5449444558414d504c453030303030310200000008090a000000' +
        '313739303030303030300a00000031383231353336303030020000000a0b',
    );
  });

  it('reads one LP(organisation_id), and refuses a trailing byte', () => {
    const answer = new Uint8Array([6, 0, 0, 0, ...new TextEncoder().encode('01JORG')]);
    expect(parseClaimAnswer(answer)).toBe('01JORG');
    expect(() => parseClaimAnswer(new Uint8Array([...answer, 0xff]))).toThrow(/trailing/);
  });
});

describe('formatRecoveryKey', () => {
  it('base32-encodes the scalar in groups of four, plus one checksum group', async () => {
    const scalar = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) scalar[i] = i;
    const text = await formatRecoveryKey(scalar);
    expect(text).toBe(
      'AAAQ-EAYE-AUDA-OCAJ-BIFQ-YDIO-B4IB-CEQT-CQKR-MFYY-DENB-WHA5-DYPQ-MMG4',
    );
    const groups = text.split('-');
    expect(groups).toHaveLength(14);
    for (const group of groups) expect(group).toHaveLength(4);
  });
});
