// A check step's paste meets the REAL wasm gate (no stand-in) (ADR-0080 decision 5). Two things must
// both hold: a secret in the paste never reaches the design, and the comparison still works. The gate
// removes a line holding a long hex value, a file's hash among them, so the comparison reads the paste
// before the gate, in memory, and only the gated paste and the verdict are kept.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { Engine } from '../../engine/engine';
import { fileLoader } from '../../engine/wasm';
import { addNode, begin, finish } from '../../document/freeform';
import { emptyDocument } from '../../document/model';
import { addStep, createPlan, readPlan, setSeen, startPlan, type TextGate } from '../../document/plans';
import { compareSeen, expectationOf } from './checkSeen';

const WASM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../public/engine/fathom_wasm.wasm');
const SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
// An 8-character secret, as short as a real device takes (CLAUDE.md rule 2).
const SECRET = 'Ab3dE6gH';

describe('a check paste passes the real gate, then is compared', () => {
  let gate: TextGate;
  beforeAll(async () => {
    if (!existsSync(WASM)) throw new Error(`${WASM} is missing; run bash scripts/build-wasm.sh first. This suite does not fall back to a stub.`);
    const engine = await Engine.init(fileLoader(WASM));
    gate = (t) => engine.redactText(t).text;
  });

  function doing(change: string) {
    const b = begin(emptyDocument(), { actor: 'a', now: 1 });
    const device = addNode(b, 'Device', {});
    const doc = finish(b, 'lab');
    const made = createPlan(doc, { title: 'Upgrade EX2300 to 23.4R2', gate: (t) => t });
    const s = addStep(made.doc, made.id, { kind: 'other', change, targets: [device], gate: (t) => t });
    return { doc: startPlan(s.doc, made.id, { now: 2 }), plan: made.id, step: s.id };
  }

  it('the gate removes a file hash, which is why the comparison reads the paste first', () => {
    expect(gate(`SHA256 (/var/tmp/junos.tgz) = ${SHA256}`)).not.toContain(SHA256);
  });

  it('a secret pasted with the output never reaches the design; the hash Matches, and only the verdict is kept', () => {
    const { doc, plan, step } = doing(`Check the SHA-256 on the device\nCompare with ${SHA256.slice(0, 4)}…${SHA256.slice(-4)}.`);
    const pasted = [
      'root@ex2300> file checksum sha-256 /var/tmp/junos.tgz',
      `SHA256 (/var/tmp/junos.tgz) = ${SHA256}`,
      '',
      'root@ex2300> show configuration security ike | display set',
      `set security ike policy ike-pol pre-shared-key ascii-text "${SECRET}"`,
    ].join('\n');
    const before = readPlan(doc, plan).steps[0]!;
    const after = setSeen(doc, step, { seen: pasted, compared: compareSeen(expectationOf(before, SHA256), pasted), gate, now: 3 });
    expect(JSON.stringify(after)).not.toContain(SECRET);
    expect(JSON.stringify(after)).not.toContain(SHA256);
    const kept = readPlan(after, plan).steps[0]!;
    expect(kept.seen).toContain('file checksum sha-256');
    expect(kept.compared).toEqual({ verdict: 'matches', why: expect.stringContaining('e3b0c442…7852b855') });
  });

  it('an IOS XE secret line is redacted; the version survives and is compared', () => {
    const { doc, plan, step } = doing('Record 17.09.04a as running\nPaste the config back.');
    const pasted = `Cisco IOS XE Software, Version 17.09.04a\nenable secret ${SECRET}\n`;
    const before = readPlan(doc, plan).steps[0]!;
    const after = setSeen(doc, step, { seen: pasted, compared: compareSeen(expectationOf(before), pasted), gate, now: 3 });
    expect(JSON.stringify(after)).not.toContain(SECRET);
    const kept = readPlan(after, plan).steps[0]!;
    expect(kept.seen).toContain('Version 17.09.04a');
    expect(kept.compared?.verdict).toBe('matches');
  });

  it('a why that held a secret is gated too', () => {
    const { doc, plan, step } = doing('Check BGP is up');
    const after = setSeen(doc, step, { seen: 'up', compared: { verdict: 'cant_tell', why: `enable secret ${SECRET}` }, gate, now: 3 });
    expect(JSON.stringify(after)).not.toContain(SECRET);
    expect(readPlan(after, plan).steps[0]!.compared?.verdict).toBe('cant_tell');
  });
});
