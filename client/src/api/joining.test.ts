import { describe, expect, it, vi } from 'vitest';

import { keyCodeOfPublicKey } from './grantBytes';

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
const pending = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);

vi.mock('../crypto/keys', () => ({
  getEnrolledKeyPair: async (address: string) => (address === 'enrolled' ? pair : null),
  getPendingKeyPair: async (address: string) => (address === 'pending' ? pending : null),
  exportPublicKeyRaw: async (key: CryptoKey) => new Uint8Array(await crypto.subtle.exportKey('raw', key)),
}));

import { keyCheckCode } from './joining';

describe('keyCheckCode', () => {
  it('is the code of the enrolled key, and of a pending one when nothing is enrolled', async () => {
    const raw = async (k: CryptoKey) => new Uint8Array(await crypto.subtle.exportKey('raw', k));
    expect(await keyCheckCode('enrolled')).toBe(await keyCodeOfPublicKey(await raw(pair.publicKey)));
    expect(await keyCheckCode('pending')).toBe(await keyCodeOfPublicKey(await raw(pending.publicKey)));
  });

  it('is null for a browser with no key', async () => {
    expect(await keyCheckCode('nobody')).toBeNull();
  });
});
