// The About page's gate check, against the REAL wasm engine (no stand-in): the canary it uses must
// be one the real gate takes out, or the check would pass for the wrong reason.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { Engine } from '../../engine/engine';
import { fileLoader } from '../../engine/wasm';
import { runSelfTests } from './selfTests';

const WASM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../public/engine/fathom_wasm.wasm');

describe('About this Fathom: the gate check uses the real gate', () => {
  it('passes with the real engine', async () => {
    if (!existsSync(WASM)) throw new Error(`${WASM} is missing; run bash scripts/build-wasm.sh first. This suite does not fall back to a stub.`);
    const engine = await Engine.init(fileLoader(WASM));
    const { results } = await runSelfTests({
      health: () => Promise.resolve('ok'),
      about: () => Promise.reject(new Error('not asked here')),
      pageCommit: '',
      redact: async (t) => engine.redactText(t).text,
      location: { protocol: 'https:', hostname: 'fathom.example' },
      pagePolicy: () => Promise.resolve(null),
    });
    expect(results.find((r) => r.id === 'gate')?.outcome).toBe('pass');
  });
});
