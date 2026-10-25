// The same fixed inputs as `crates/fathom-server/tests/vault.rs`'s
// `the_signed_byte_strings_match_the_clients`, and the same pinned hashes. If either side's
// builder changes, one of the two tests fails, and the message says which bytes.

import { describe, expect, it } from 'vitest';

import { toHex } from '../crypto/bytes';
import { keyFpr, modeChangeBytes, personKeyBytes, recoveryKeyBytes, sha256, shareBytes, supersedeBytes, wrapDigest } from './bytes';

const org = '01JORG0000000000000000000A';
const account = '01JACC0000000000000000000B';
const filled = (n: number, v: number) => new Uint8Array(n).fill(v);
const at = 1_761_400_000;

async function hash(bytes: Uint8Array): Promise<string> {
  return toHex(await sha256(bytes));
}

describe('vault byte strings, pinned against the server', () => {
  const pub = filled(65, 4);
  const signer = filled(32, 0x11);

  it('person enrolment', async () => {
    expect(await hash(personKeyBytes(org, account, pub, signer, at))).toBe(
      'eb716eb9954df8c5a3eb6bbf998dd3c7b66381f19b7bf86995bf355adbfc49b3',
    );
  });

  it('recovery enrolment', async () => {
    expect(await hash(recoveryKeyBytes(org, pub, account, signer, at))).toBe(
      '1d179ca1b47ccab474b62c416b2b02b601f25930596af12e7e016643e241e8fa',
    );
  });

  it('succession', async () => {
    expect(await hash(supersedeBytes(org, 'person', account, filled(32, 1), filled(32, 2), at))).toBe(
      '14688e920cf26338b5f773b5030d87d196022a0f4f985fed73508730208c9dd8',
    );
  });

  it('a share, whatever order the recipients arrive in', async () => {
    const recipients = [
      { who: account, keyFpr: filled(32, 5), digest: filled(32, 6) },
      { who: 'recovery', keyFpr: filled(32, 3), digest: filled(32, 4) },
    ];
    const pinned = 'd857a8c2a17c0458ab354c3f27a0e6ef1c8e1ef6b6bc0c6a99f51ee062b47d16';
    expect(await hash(shareBytes(org, 'cred_01JCRED000000000000000000', 2, recipients, account, signer, at))).toBe(pinned);
    expect(await hash(shareBytes(org, 'cred_01JCRED000000000000000000', 2, [...recipients].reverse(), account, signer, at))).toBe(
      pinned,
    );
  });

  it('fingerprint and wrap digest', async () => {
    expect(toHex(await keyFpr(pub))).toBe('df20fa2559b3e586ccfc19b3bae30ee60a22ef6cd236d45a8eb8a823680b9bec');
    expect(toHex(await wrapDigest(filled(137, 7)))).toBe(
      'b31a268762219208e5f71191e9338a8b711799df3f7d1f8d80ca30048832ba2a',
    );
  });

  it('consent to Fathom keeping a copy (vault_fathom.rs)', async () => {
    const recipients = [
      { who: account, keyFpr: filled(32, 5), digest: filled(32, 6) },
      { who: 'recovery', keyFpr: filled(32, 3), digest: filled(32, 4) },
    ];
    const bytes = modeChangeBytes(org, 'cred_01JCRED000000000000000000', 'A', 'B', 2, 3, account, signer, recipients, '0123456789abcdef', at, 41);
    expect(await hash(bytes)).toBe('9ff91a76deeba277d39400308bfb32b227ad55ffb97ec3529719a8d212ff5fc7');
  });
});
