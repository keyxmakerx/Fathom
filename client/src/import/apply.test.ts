// The whole import against a real design: what it writes, that it is ONE undo step, and that the
// result still loads through the Rust reader (before undo, after it, and after redo).

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { Engine } from '../engine/engine';
import { fileLoader } from '../engine/wasm';
import { fieldValue } from '../document/fields';
import { readChassisFields, findNode, edgesOut, type Document } from '../document/model';
import { notesOf } from '../document/notes';
import { tagsOf } from '../document/tags';
import { redo, undo, undoable } from '../document/undo';
import { writePlain } from '../document/plain';
import { applyPlan } from './apply';
import { devicesByName } from './existing';
import { buildPlan, choiceKey } from './plan';
import { ACTOR, CATALOGUE, COST_CENTRE, NOW, addDevice, docWithRack, fixture, freshDefs, fullMapping, gated, miniXml, readImport } from './testkit';

const WASM_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/engine/fathom_wasm.wasm');
let engine: Engine;
beforeAll(async () => {
  if (!existsSync(WASM_PATH)) throw new Error(`${WASM_PATH} is missing; run bash scripts/build-wasm.sh first.`);
  engine = await Engine.init(fileLoader(WASM_PATH));
});

const live = (d: Document) => d.nodes.filter((n) => n.absentSince === undefined).map((n) => n.id).sort();
const liveEdges = (d: Document) => d.edges.filter((e) => e.absentSince === undefined).map((e) => e.id).sort();

async function run(file: string, doc: Document) {
  const table = await gated(readImport(fixture(file), { xml: miniXml }));
  const defs = [COST_CENTRE];
  const plan = buildPlan(table, fullMapping(table, defs), { doc, catalogue: CATALOGUE, defs });
  const fresh = freshDefs(plan.newFields);
  const out = await applyPlan(doc, plan, { defs: [...defs, ...fresh], fresh, actor: ACTOR, now: NOW + 5, label: `import ${file}` });
  return { plan, fresh, out };
}

describe('importing the NetBox CSV', () => {
  async function setup() {
    let { doc, rackId } = docWithRack();
    doc = addDevice(doc, 'sw-01', { serial: 'JN123456AB' });
    doc = addDevice(doc, 'fw-01', { serial: 'OLD-SERIAL', role: 'router' });
    return { doc, rackId, ...(await run('netbox-devices.csv', doc)) };
  }

  it('writes devices, placements, roles, addresses, tags, notes and shared fields through the commands', async () => {
    const { doc, rackId, out, fresh } = await setup();
    expect(out.refused).toEqual([]);
    expect(out.created).toBe(5);
    expect(out.placed).toBe(2);
    const d = devicesByName(out.doc);
    const sw02 = d.get('sw-02')!;
    expect(sw02).toMatchObject({ model: 'EX2300-48P', role: 'switch', mgmt: '10.0.99.3', serial: 'JN123457CD' });
    expect(edgesOut(out.doc, sw02.chassisId, 'MountedIn')[0]!.to).toBe(rackId);
    expect(tagsOf(out.doc, sw02.deviceId).map((t) => t.name).sort()).toEqual(['access']);
    const ownerDef = fresh.find((f) => f.name === 'Owner')!;
    expect(fieldValue(out.doc, sw02.deviceId, ownerDef.id)).toBe('Facilities');
    // A free box: no model, not mounted, hostname kept, the model text kept as a note.
    const spaced = d.get('core-switch-2')!;
    expect(spaced.model).toBe('');
    expect(edgesOut(out.doc, spaced.chassisId, 'MountedIn')).toEqual([]);
    expect(notesOf(out.doc, spaced.deviceId).map((n) => n.text)).toContain('Model in the file: Box 9000');
    // Match: filled, not overwritten. Differ, default: only blanks.
    expect(d.get('sw-01')).toMatchObject({ serial: 'JN123456AB', role: 'switch', mgmt: '10.0.99.2' });
    expect(d.get('fw-01')).toMatchObject({ serial: 'OLD-SERIAL', role: 'router', mgmt: '10.0.99.1' });
    expect(fieldValue(out.doc, d.get('fw-01')!.deviceId, ownerDef.id)).toBe('Security');
    expect(d.size).toBe(2 + 5);
    expect(readChassisFields(findNode(out.doc, sw02.chassisId)!).serial).toBe('JN123457CD');
    void doc;
  });

  it('is ONE undo step: one undo removes everything, one redo puts it all back, and every state loads', async () => {
    const { doc, out } = await setup();
    expect(out.doc.batches).toHaveLength(doc.batches.length + 1);
    expect(() => engine.loadPlain(writePlain(out.doc))).not.toThrow();

    const step = undoable(out.doc, ACTOR)[0]!;
    expect(step.label).toBe('import netbox-devices.csv');
    const undone = undo(out.doc, step.id, { actor: ACTOR, now: NOW + 100 });
    expect(live(undone)).toEqual(live(doc));
    expect(liveEdges(undone)).toEqual(liveEdges(doc));
    const before = devicesByName(doc);
    const after = devicesByName(undone);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [k, b] of before) expect(after.get(k)).toMatchObject({ role: b.role, mgmt: b.mgmt, serial: b.serial });
    expect(tagsOf(undone, before.get('sw-01')!.deviceId)).toEqual([]);
    expect(notesOf(undone, before.get('sw-01')!.deviceId)).toEqual([]);
    expect(() => engine.loadPlain(writePlain(undone))).not.toThrow();

    const redone = redo(undone, undone.batches.at(-1)!.id, { actor: ACTOR, now: NOW + 200 });
    expect(live(redone)).toEqual(live(out.doc));
    expect(liveEdges(redone)).toEqual(liveEdges(out.doc));
    expect(devicesByName(redone).get('sw-01')).toMatchObject({ role: 'switch', mgmt: '10.0.99.2' });
    expect(() => engine.loadPlain(writePlain(redone))).not.toThrow();
  });

  it('undoing a Differ row that took the file\'s values brings the old ones back', async () => {
    let { doc } = docWithRack();
    doc = addDevice(doc, 'fw-01', { serial: 'OLD-SERIAL', role: 'router' });
    const table = await gated(readImport(fixture('netbox-devices.csv')));
    const plan = buildPlan(table, fullMapping(table, []), { doc, catalogue: CATALOGUE, defs: [] });
    const row = choiceKey(plan.items.find((i) => i.name === 'fw-01')!);
    const fresh = freshDefs(plan.newFields);
    const out = await applyPlan(doc, plan, { choices: new Map([[row, 'theirs']]), defs: fresh, fresh, actor: ACTOR, now: NOW + 5, label: 'import' });
    expect(devicesByName(out.doc).get('fw-01')).toMatchObject({ serial: 'JN998877EF', role: 'firewall' });
    const undone = undo(out.doc, undoable(out.doc, ACTOR)[0]!.id, { actor: ACTOR, now: NOW + 100 });
    expect(devicesByName(undone).get('fw-01')).toMatchObject({ serial: 'OLD-SERIAL', role: 'router' });
    expect(() => engine.loadPlain(writePlain(undone))).not.toThrow();
  });

  it('a second run of the same file creates nothing new', async () => {
    const { out } = await setup();
    const again = await run('netbox-devices.csv', out.doc);
    expect(again.out.created).toBe(0);
    expect(again.plan.counts.new).toBe(0);
    expect(again.plan.counts.nomodel).toBe(0);
  });
});

describe('the other formats', () => {
  it.each(['netbox-devices.json', 'pvesh-resources.json', 'pvesh-qemu-config.json', 'pvesh-lxc-config.json', 'nmap.xml'])('%s imports as one loadable undo step', async (file) => {
    const { doc } = docWithRack();
    const { out } = await run(file, doc);
    expect(out.refused).toEqual([]);
    expect(out.created).toBeGreaterThan(0);
    expect(out.doc.batches).toHaveLength(doc.batches.length + 1);
    expect(() => engine.loadPlain(writePlain(out.doc))).not.toThrow();
    const undone = undo(out.doc, undoable(out.doc, ACTOR)[0]!.id, { actor: ACTOR, now: NOW + 100 });
    expect(live(undone)).toEqual(live(doc));
    expect(() => engine.loadPlain(writePlain(undone))).not.toThrow();
  });

  it('NetBox JSON places sw-01 and fw-01 by rack and unit; nmap addresses become management addresses', async () => {
    const { doc } = docWithRack();
    const json = await run('netbox-devices.json', doc);
    expect(json.out.placed).toBe(2);
    expect(devicesByName(json.out.doc).get('sw-01')).toMatchObject({ model: 'EX2300-48P', mgmt: '10.0.99.2', serial: 'JN123456AB' });
    const nmap = await run('nmap.xml', doc);
    expect(devicesByName(nmap.out.doc).get('10.0.99.50')).toMatchObject({ mgmt: '10.0.99.50' });
  });
});

describe('a thousand rows', () => {
  it('imports in a reasonable time as one undo step', async () => {
    const { doc } = docWithRack();
    const rows = Array.from({ length: 1000 }, (_, i) => `host-${i},${i % 7 === 0 ? 'switch' : 'server'},10.1.${Math.floor(i / 250)}.${(i % 250) + 1},SN${i},grp${i % 5}`).join('\n');
    const table = await gated(readImport(`name,role,ip,serial,tags\n${rows}\n`));
    const plan = buildPlan(table, fullMapping(table, []), { doc, catalogue: CATALOGUE, defs: [] });
    const t0 = performance.now();
    const out = await applyPlan(doc, plan, { defs: [], fresh: [], actor: ACTOR, now: NOW, label: 'import big.csv' });
    const ms = performance.now() - t0;
    console.log(`import of 1000 devices with tags: ${ms.toFixed(0)}ms`);
    expect(out.created).toBe(1000);
    expect(out.doc.batches).toHaveLength(doc.batches.length + 1);
    expect(ms).toBeLessThan(60_000);
  }, 120_000);
});
