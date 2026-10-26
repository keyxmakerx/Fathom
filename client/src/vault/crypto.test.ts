// The vault's browser crypto, in Node's WebCrypto (the same SubtleCrypto interface). What the
// server checks is `crates/fathom-server/tests/vault.rs`; this is what only the browser can check:
// that a wrap opens for its recipient and for nobody else, and that every binding in §13.7's
// `wrap_info` actually binds.

import { describe, expect, it } from 'vitest';

import { keyFpr } from './bytes';
import {
  WrongSecret,
  base32,
  fingerprintText,
  fromBase32,
  makeRecoveryKey,
  newContentKey,
  openRecoveryKey,
  openSecret,
  recoveryText,
  sealSecret,
  unwrap,
  vaultKeyText,
  wrapTo,
  type OpenVaultKey,
} from './crypto';

const org = '01JORG0000000000000000000A';
const cred = 'cred_01JCRED00000000000000000A';

async function aPerson(): Promise<{ key: OpenVaultKey; fpr: Uint8Array }> {
  // A recovery key is the same ECDH shape as a person's, and needs no engine to make.
  const made = await makeRecoveryKey(org, 'someone');
  const key = await openRecoveryKey(org, 'someone', made, made.sheetSecret);
  return { key, fpr: await keyFpr(key.publicKey) };
}

describe('codes people copy by hand', () => {
  it('round-trips, and forgives case, dashes and look-alike letters', () => {
    const secret = Uint8Array.from({ length: 16 }, (_, i) => i * 17);
    const printed = vaultKeyText(secret);
    expect(printed).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{6}$/);
    expect(fromBase32(printed, 16)).toEqual(secret);
    expect(fromBase32(printed.toLowerCase().replace(/-/g, ' '), 16)).toEqual(secret);
    expect(fromBase32(printed.replace(/0/g, 'O').replace(/1/g, 'I'), 16)).toEqual(secret);
  });

  it('refuses a code one character short, or with nonzero padding bits', () => {
    const secret = new Uint8Array(16).fill(255);
    const t = base32(secret);
    expect(fromBase32(t.slice(1), 16)).toBeNull();
    expect(fromBase32(`${t.slice(0, -1)}Z`, 16)).toBeNull();
  });

  it('prints the recovery secret as 13 groups of 4 and a fingerprint as 4 groups of 6', () => {
    expect(recoveryText(new Uint8Array(32))).toMatch(/^(0000-){12}0000$/);
    expect(fingerprintText(new Uint8Array(32).fill(255))).toBe('ZZZZZZ-ZZZZZZ-ZZZZZZ-ZZZZZZ');
  });
});

describe('wraps (§13.7)', () => {
  it('opens for its recipient, is 137 bytes, and gives back the content key', async () => {
    const alice = await aPerson();
    const ctx = { organisation: org, credential: cred, epoch: 1, sharerKeyFpr: new Uint8Array(32).fill(9) };
    const contentKey = newContentKey();
    const wrap = await wrapTo(ctx, alice.key.publicKey, alice.fpr, contentKey);
    expect(wrap.length).toBe(137);
    expect(await unwrap(ctx, alice.key, alice.fpr, wrap)).toEqual(contentKey);
  });

  it('does not open for anyone else, nor when moved to another epoch, login or sharer', async () => {
    const alice = await aPerson();
    const bob = await aPerson();
    const ctx = { organisation: org, credential: cred, epoch: 1, sharerKeyFpr: new Uint8Array(32).fill(9) };
    const wrap = await wrapTo(ctx, alice.key.publicKey, alice.fpr, newContentKey());
    await expect(unwrap(ctx, bob.key, bob.fpr, wrap)).rejects.toBeInstanceOf(WrongSecret);
    await expect(unwrap({ ...ctx, epoch: 2 }, alice.key, alice.fpr, wrap)).rejects.toBeInstanceOf(WrongSecret);
    await expect(unwrap({ ...ctx, credential: `${cred.slice(0, -1)}B` }, alice.key, alice.fpr, wrap)).rejects.toBeInstanceOf(WrongSecret);
    await expect(unwrap({ ...ctx, sharerKeyFpr: new Uint8Array(32) }, alice.key, alice.fpr, wrap)).rejects.toBeInstanceOf(WrongSecret);
  });

  it('refuses a wrap that is not shaped like one', async () => {
    const alice = await aPerson();
    const ctx = { organisation: org, credential: cred, epoch: 1, sharerKeyFpr: new Uint8Array(32) };
    const wrap = await wrapTo(ctx, alice.key.publicKey, alice.fpr, newContentKey());
    await expect(unwrap(ctx, alice.key, alice.fpr, wrap.slice(0, 136))).rejects.toThrow(/not shaped/);
  });
});

describe("a login's secret", () => {
  it('opens under its key and epoch only', async () => {
    const key = newContentKey();
    const secret = { username: 'admin', password: 'Correct-Horse-9', note: 'core switch' };
    const sealed = await sealSecret(org, cred, 3, key, secret);
    expect(await openSecret(org, cred, 3, key, sealed.ct, sealed.nonce)).toEqual(secret);
    await expect(openSecret(org, cred, 4, key, sealed.ct, sealed.nonce)).rejects.toBeInstanceOf(WrongSecret);
    await expect(openSecret(org, cred, 3, newContentKey(), sealed.ct, sealed.nonce)).rejects.toBeInstanceOf(WrongSecret);
  });

  it('refuses one too long to store', async () => {
    await expect(sealSecret(org, cred, 1, newContentKey(), { username: '', password: 'x'.repeat(9000), note: '' })).rejects.toThrow(/too long/);
  });
});

describe('the recovery sheet', () => {
  it('opens with its own secret and not with another', async () => {
    const made = await makeRecoveryKey(org, 'steward');
    await expect(openRecoveryKey(org, 'steward', made, new Uint8Array(32))).rejects.toBeInstanceOf(WrongSecret);
    await expect(openRecoveryKey(org, 'another', made, made.sheetSecret)).rejects.toBeInstanceOf(WrongSecret);
    const opened = await openRecoveryKey(org, 'steward', made, made.sheetSecret);
    expect(opened.publicKey).toEqual(made.publicKey);
  });
});
