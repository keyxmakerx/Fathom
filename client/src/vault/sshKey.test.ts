import { describe, expect, it } from 'vitest';

import { isSshKey, makeEd25519Key, openSshEd25519, parseOpenSshKey } from './sshKey';

// Written by Python's `cryptography` 50.0.1 (an implementation apart from this one) for the seed
// 01 02 … 20 with no comment: `Ed25519PrivateKey.from_private_bytes(seed).private_bytes(PEM,
// OpenSSH, NoEncryption())`. A fixture only: anyone can rebuild it from the seed.
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const PUB = Uint8Array.from('79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664'.match(/../g)!.map((h) => parseInt(h, 16)));
const CHECK = 1807431326;
// Only the base64 lines are kept in the source and the armour is added here, so secret scanners
// don't take this public fixture for a leaked key.
const ARMOUR = (kind: string) => `-----${kind} OPENSSH ${'PRIVATE'} KEY-----`;
const BODY = [
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz',
  'c2gtZWQyNTUxOQAAACB5tVYuj+ZU+UB4sRLoqYunkB+FOuaVvtfg45ELrQSWZAAA',
  'AIhruzaea7s2ngAAAAtzc2gtZWQyNTUxOQAAACB5tVYuj+ZU+UB4sRLoqYunkB+F',
  'OuaVvtfg45ELrQSWZAAAAEABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f',
  'IHm1Vi6P5lT5QHixEuipi6eQH4U65pW+1+DjkQutBJZkAAAAAAECAwQF',
];
const BY_CRYPTOGRAPHY = `${ARMOUR('BEGIN')}\n${BODY.join('\n')}\n${ARMOUR('END')}\n`;
const BY_CRYPTOGRAPHY_PUBLIC = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHm1Vi6P5lT5QHixEuipi6eQH4U65pW+1+DjkQutBJZk';

const body = (armoured: string) => atob(armoured.trim().split('\n').slice(1, -1).join(''));

/** A key file's header and public half only, with the cipher and key type given: enough for the
 * checks, which never read the private section. */
function header(cipher: string, type: string): string {
  const enc = new TextEncoder();
  const str = (v: Uint8Array) => [...[24, 16, 8, 0].map((s) => (v.length >>> s) & 255), ...v];
  const pub = [...str(enc.encode(type)), ...str(new Uint8Array(32))];
  const bytes = [
    ...enc.encode('openssh-key-v1\0'),
    ...str(enc.encode(cipher)),
    ...str(enc.encode('none')),
    ...str(new Uint8Array(0)),
    0,
    0,
    0,
    1,
    ...str(Uint8Array.from(pub)),
    ...str(new Uint8Array(8)),
  ];
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${btoa(String.fromCharCode(...bytes))}\n-----END OPENSSH PRIVATE KEY-----`;
}

describe('SSH key logins', () => {
  it('reads a key another implementation wrote and gives its public key line', () => {
    expect(parseOpenSshKey(BY_CRYPTOGRAPHY)).toEqual({
      ok: true,
      type: 'ssh-ed25519',
      publicLine: BY_CRYPTOGRAPHY_PUBLIC,
    });
    expect(parseOpenSshKey(BY_CRYPTOGRAPHY, 'fathom-read')).toEqual({
      ok: true,
      type: 'ssh-ed25519',
      publicLine: `${BY_CRYPTOGRAPHY_PUBLIC} fathom-read`,
    });
  });

  it('writes the same bytes for the same seed', () => {
    expect(body(openSshEd25519(SEED, PUB, '', CHECK))).toBe(body(BY_CRYPTOGRAPHY));
  });

  it('refuses RSA and DSA, a passphrase, other types, and a key cut short', () => {
    const rsa = parseOpenSshKey(header('none', 'ssh-rsa'));
    expect(!rsa.ok && rsa.why).toMatch(/never an RSA/);
    expect(parseOpenSshKey(header('none', 'ssh-dss')).ok).toBe(false);
    const locked = parseOpenSshKey(header('aes256-ctr', 'ssh-ed25519'));
    expect(!locked.ok && locked.why).toMatch(/passphrase/);
    expect(parseOpenSshKey(header('none', 'sk-ssh-ed25519@openssh.com')).ok).toBe(false);
    expect(parseOpenSshKey(header('none', 'ecdsa-sha2-nistp256')).ok).toBe(true);
    const cut = BY_CRYPTOGRAPHY.split('\n').slice(0, 2).join('\n') + '\n-----END OPENSSH PRIVATE KEY-----';
    expect(parseOpenSshKey(cut).ok).toBe(false);
    expect(parseOpenSshKey('hunter2').ok).toBe(false);
  });

  it('makes an Ed25519 key that reads back as one', async () => {
    const k = await makeEd25519Key('fathom-read');
    expect(isSshKey(k.privateKey)).toBe(true);
    expect(k.publicLine).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43} fathom-read$/);
    expect(parseOpenSshKey(k.privateKey, 'fathom-read')).toEqual({
      ok: true,
      type: 'ssh-ed25519',
      publicLine: k.publicLine,
    });
    // The private section is padded to a multiple of 8, as PROTOCOL.key says for no cipher.
    const raw = body(k.privateKey);
    const privLen = raw.length - (15 + 8 + 8 + 4 + 4 + 4 + 51) - 4;
    expect(privLen % 8).toBe(0);
  });

  it('tells a key from a password', () => {
    expect(isSshKey('  -----BEGIN OPENSSH PRIVATE KEY-----\nx')).toBe(true);
    expect(isSshKey('correct horse battery staple')).toBe(false);
  });
});
