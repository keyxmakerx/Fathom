// A person's vault key through the REAL module's Argon2id (`OP_VAULT_KDF`), the way the browser
// makes and opens it. Needs `bash scripts/build-wasm.sh`, like `engine.test.ts`.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { toHex } from '../crypto/bytes';
import { Engine } from '../engine/engine';
import { fileLoader } from '../engine/wasm';
import { KDF, WrongSecret, makePersonKey, newVaultSecret, openPersonKey } from './crypto';

const WASM_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/engine/fathom_wasm.wasm');
if (!existsSync(WASM_PATH)) throw new Error(`${WASM_PATH} does not exist. Run \`bash scripts/build-wasm.sh\` first.`);

const org = '01JORG0000000000000000000A';
const me = '01JACC0000000000000000000B';
let engine: Engine;

beforeAll(async () => {
  engine = await Engine.init(fileLoader(WASM_PATH));
});

describe('OP_VAULT_KDF from the browser side', () => {
  it('derives the same key from the same inputs, and another from another vault key', () => {
    // The RFC 9106 §5.3 vector itself is pinned in `crates/fathom-wasm/src/vaultkdf.rs`; it uses
    // associated data and 4 lanes, which this opcode does not take.
    const pw = new TextEncoder().encode('correct horse battery staple');
    const salt = new Uint8Array(16).fill(1);
    const a = engine.vaultKdf(pw, salt, new Uint8Array(16).fill(2), 19_456, 2, 1);
    const b = engine.vaultKdf(pw, salt, new Uint8Array(16).fill(2), 19_456, 2, 1);
    const c = engine.vaultKdf(pw, salt, new Uint8Array(16).fill(3), 19_456, 2, 1);
    expect(toHex(a)).toBe(toHex(b));
    expect(toHex(a)).not.toBe(toHex(c));
    expect(a).toHaveLength(32);
  });

  it('refuses settings below the floor', () => {
    expect(() => engine.vaultKdf(new Uint8Array(1), new Uint8Array(16), new Uint8Array(16), 1024, 2, 1)).toThrow();
  });

  it('opens a new vault key with the passphrase and kit, and with nothing else', async () => {
    const secret = newVaultSecret();
    const started = performance.now();
    const made = await makePersonKey(engine, org, me, 'quiet otter river lamp', secret);
    const ms = performance.now() - started;
    console.log(`Argon2id m=${KDF.m} t=${KDF.t} p=${KDF.p} in this process: ${Math.round(ms)} ms`);
    const sealed = { ...made, m: KDF.m, t: KDF.t, p: KDF.p };
    const opened = await openPersonKey(engine, org, me, sealed, 'quiet otter river lamp', secret);
    expect(opened.publicKey).toEqual(made.publicKey);
    await expect(openPersonKey(engine, org, me, sealed, 'quiet otter river lamb', secret)).rejects.toBeInstanceOf(WrongSecret);
    await expect(openPersonKey(engine, org, me, sealed, 'quiet otter river lamp', newVaultSecret())).rejects.toBeInstanceOf(WrongSecret);
    await expect(openPersonKey(engine, org, 'someone-else', sealed, 'quiet otter river lamp', secret)).rejects.toBeInstanceOf(WrongSecret);
  }, 60_000);
});
