// Gate coverage (CLAUDE.md rules 2 and 4): every cell goes through the gate before anything is
// kept, with secrets of the lengths real devices take, inside CSV cells, JSON comments and nmap
// script output. The last block runs the REAL wasm engine, not a stand-in.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { Engine } from '../engine/engine';
import { fileLoader } from '../engine/wasm';
import { applyPlan } from './apply';
import { gateTable, type Redact } from './gate';
import { defaultMapping } from './mapping';
import { buildPlan } from './plan';
import { readImport } from './read';
import { ACTOR, CATALOGUE, NOW, docWithRack, fixture, miniXml, stubRedact } from './testkit';

const PSK_80 = `Tz9${'kQ4vL2mXa7Pw'.repeat(6)}Rb`;
// Distinct, real-length secrets: community strings, an IKE pre-shared key, an 80-character BGP key.
const SECRETS = [
  'FATHOMIMPORTsnmpRoCommunity2f9c1d7e',
  'FATHOMIMPORTikePreSharedKey0123456789abcdef',
  PSK_80,
  'FATHOMIMPORTbannerComm',
  'FATHOMIMPORTscriptComm0123456789',
];

const FILES: Array<[string, string]> = [
  ['netbox-devices.csv', 'CSV cells'],
  ['netbox-devices.json', 'JSON comments'],
  ['nmap.xml', 'nmap script output'],
  ['pvesh-qemu-config.json', 'a Proxmox description'],
];

const read = (name: string) => readImport(fixture(name), { xml: miniXml });
const leaked = (text: string) => SECRETS.filter((s) => text.includes(s));

describe('every value passes the gate (stand-in redactor)', () => {
  it.each(FILES)('%s: the fixture really carries secrets, and none survive the gate (%s)', async (name) => {
    const raw = read(name);
    expect(leaked(JSON.stringify(raw)).length).toBeGreaterThan(0);
    const gated = await gateTable(raw, stubRedact);
    expect(leaked(JSON.stringify(gated))).toEqual([]);
  });

  it('hands every non-empty distinct header and cell to the gate, and nothing is skipped', async () => {
    const raw = read('netbox-devices.csv');
    const seen = new Set<string>();
    const spy: Redact = async (t) => {
      seen.add(t);
      return stubRedact(t);
    };
    await gateTable(raw, spy);
    const want = new Set([...raw.headers, ...raw.rows.flat()].map((c) => c.replace(/\t/g, ' ')).filter((c) => c.trim() !== ''));
    for (const w of want) if (!w.startsWith('\t') && !/^[\s]/.test(w)) expect(seen, `not gated: ${w}`).toContain(w);
  });

  it('a gate that fails stops the import: nothing comes back', async () => {
    const boom: Redact = async () => {
      throw new Error('gate down');
    };
    await expect(gateTable(read('netbox-devices.csv'), boom)).rejects.toThrow('gate down');
  });

  it('what reaches the design never holds a secret: CSV, JSON and nmap, through plan and apply', async () => {
    for (const [name] of FILES) {
      const gated = await gateTable(read(name), stubRedact);
      const { doc } = docWithRack();
      const plan = buildPlan(gated, defaultMapping(gated, []), { doc, catalogue: CATALOGUE, defs: [] });
      const fresh = plan.newFields.map((f, i) => ({ id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(i + 10)}`, appliesTo: 'device' as const, name: f.name, type: f.type, choices: [], version: 1, createdBy: ACTOR, archived: false }));
      const out = await applyPlan(doc, plan, { defs: fresh, fresh, actor: ACTOR, now: NOW, label: `import ${name}` });
      expect(out.created, name).toBeGreaterThan(0);
      expect(leaked(JSON.stringify(out.doc)), name).toEqual([]);
    }
  });

  it('a value the gate leaves alone is kept; the gate is the only thing that changes secrets', async () => {
    const gated = await gateTable(readImport('name,comments\nsw-01,Upstairs; see ticket 4411\n'), stubRedact);
    expect(gated.rows).toEqual([['sw-01', 'Upstairs; see ticket 4411']]);
  });
});

const WASM_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/engine/fathom_wasm.wasm');

describe('every value passes the REAL gate (wasm engine)', () => {
  let engine: Engine;
  beforeAll(async () => {
    if (!existsSync(WASM_PATH)) throw new Error(`${WASM_PATH} is missing; run bash scripts/build-wasm.sh first. This suite does not fall back to a stub.`);
    engine = await Engine.init(fileLoader(WASM_PATH));
  });
  const real: Redact = async (t) => engine.redactText(t).text;

  it.each(FILES)('%s: no real-length secret survives (%s)', async (name) => {
    const gated = await gateTable(read(name), real);
    expect(leaked(JSON.stringify(gated))).toEqual([]);
  });

  it('a device saved from the CSV carries none of the secrets, and an ordinary cell still arrives', async () => {
    const gated = await gateTable(read('netbox-devices.csv'), real);
    const { doc } = docWithRack();
    const plan = buildPlan(gated, defaultMapping(gated, []), { doc, catalogue: CATALOGUE, defs: [] });
    const fresh = plan.newFields.map((f, i) => ({ id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(i + 10)}`, appliesTo: 'device' as const, name: f.name, type: f.type, choices: [], version: 1, createdBy: ACTOR, archived: false }));
    const out = await applyPlan(doc, plan, { defs: fresh, fresh, actor: ACTOR, now: NOW, label: 'import csv' });
    const text = JSON.stringify(out.doc);
    expect(leaked(text)).toEqual([]);
    expect(text).toContain('Upstairs; see ticket 4411');
  });
});
