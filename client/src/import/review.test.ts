// Regression tests for the security review of the importer: secrets in their own column, nmap
// script output, the shared-field cap, stale conflicts, key collection, labels, formulas, invisible
// characters and long numbers. The first block runs the REAL wasm gate.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { setChassisField } from '../document/edit';
import { undoable } from '../document/undo';
import { Engine } from '../engine/engine';
import { fileLoader } from '../engine/wasm';
import { applyPlan, importLabel } from './apply';
import { devicesByName } from './existing';
import { gateTable, type Redact } from './gate';
import { quoteLongNumbers } from './json';
import { LIMITS, ImportRefusal } from './limits';
import { SECRET_REASON, defaultMapping, looksLikeSecret, mappingErrors, newFieldFor, type Mapping } from './mapping';
import { buildPlan, choiceKey, holdChangedConflicts } from './plan';
import { readImport } from './read';
import { tableOfRecords } from './table';
import { neutraliseFormula, stripUnsafe } from './text';
import { ACTOR, CATALOGUE, NOW, addDevice, docWithRack, freshDefs, fullMapping, gated, identity, miniXml, readImport as read } from './testkit';

const WASM_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/engine/fathom_wasm.wasm');
const S1 = 'S3cr3t-Pa55w0rd!2026xyz-Rk3vT9qLw2pX';
const S2 = 'N0tP4blic_Str1ng_2026_xyz_Qm8Vb3Lp9Zk4';
const S3 = 'Sn4pCommun1ty-Zx81-QwErTy-0042';

describe('1 · a secret in a column of its own (real gate)', () => {
  let real: Redact;
  beforeAll(async () => {
    if (!existsSync(WASM_PATH)) throw new Error(`${WASM_PATH} is missing; run bash scripts/build-wasm.sh first. This suite does not fall back to a stub.`);
    const engine = await Engine.init(fileLoader(WASM_PATH));
    real = async (t) => engine.redactText(t).text;
  });

  const CSV = `name,Owner,cf_snmp_community,cf_ipmi_password,password,community\nsw-01,Facilities,${S1},${S2},${S3},${S1}\n`;
  const JSON_IN = JSON.stringify([{ name: 'sw-01', Owner: 'Facilities', custom_fields: { snmp_community: S1, ipmi_password: S2 }, password: S3, apiKey: S2 }]);

  it.each([
    ['CSV', CSV],
    ['JSON', JSON_IN],
  ])('%s: the gate alone lets the values through, and they still reach nothing', async (_n, text) => {
    const table = await gateTable(read(text), real);
    // The premise of the finding: the gate sees each cell alone and leaves these.
    const cells = JSON.stringify(table.rows);
    expect([S1, S2, S3].filter((s) => cells.includes(s)).length).toBeGreaterThan(0);

    const { doc } = docWithRack();
    const ctx = { doc, catalogue: CATALOGUE, defs: [] };
    const byDefault = defaultMapping(table, []);
    table.headers.forEach((h, i) => {
      if (looksLikeSecret(h)) expect(byDefault[i], h).toEqual({ kind: 'ignore' });
    });
    // Even a mapping forced onto the secret columns (an old saved choice, a bug) is refused and unread.
    const forced: Mapping = byDefault.map((t, i) => (t.kind === 'ignore' ? newFieldFor(table, i) : t));
    expect(mappingErrors(table, forced, []).join(' ')).toContain(SECRET_REASON);
    for (const mapping of [byDefault, forced, fullMapping(table)]) {
      const plan = buildPlan(table, mapping, ctx);
      const fresh = freshDefs(plan.newFields);
      const out = await applyPlan(doc, plan, { defs: fresh, fresh, actor: ACTOR, now: NOW, label: importLabel(1) });
      expect(out.created).toBe(1);
      for (const s of [S1, S2, S3]) {
        expect(JSON.stringify(plan), s).not.toContain(s);
        expect(JSON.stringify(out.doc), s).not.toContain(s);
      }
    }
  });

  it('an unknown CSV or JSON column is Ignore until the person picks it; Owner is never made on its own', async () => {
    for (const text of [CSV, JSON_IN]) {
      const table = await gateTable(read(text), real);
      const m = defaultMapping(table, []);
      expect(m[table.headers.indexOf('Owner')]).toEqual({ kind: 'ignore' });
      expect(buildPlan(table, m, { doc: docWithRack().doc, catalogue: CATALOGUE, defs: [] }).newFields).toEqual([]);
    }
  });
});

describe('1 · the header guard', () => {
  it.each([
    'password', 'Password', 'cf_snmp_community', 'cf_ipmi_password', 'snmpCommunity', 'custom_fields.api_key', 'API Key', 'apikey', 'wifi-psk', 'secret',
    'auth_token', 'authentication', 'BMC address', 'private_key', 'cookie', 'session_id', 'seed', 'PIN', 'ssh key', 'cipassword', 'credentials', 'passwd', 'login_pass',
  ])('%s looks like a secret', (h) => expect(looksLikeSecret(h)).toBe(true));

  it.each(['name', 'serial', 'Owner', 'rack', 'primary_ip4', 'device_type', 'cf_warranty_end', 'description', 'monkey', 'ping', 'status'])('%s does not', (h) => expect(looksLikeSecret(h)).toBe(false));
});

describe('2 · nmap script output', () => {
  const xml = `<nmaprun><host><status state="up"/><address addr="10.0.0.5" addrtype="ipv4"/><hostnames><hostname name="sw-a"/></hostnames><ports>
<port protocol="udp" portid="161"><state state="open"/><service name="snmp"/><script id="snmp-brute" output="admin:Hunt3rTwo-Brute-9981Zq"/></port>
<port protocol="tcp" portid="21"><state state="open"/><service name="ftp"/><script id="ftp-brute" output="root:Ftp-Pw-77431-xyz"/></port>
<port protocol="tcp" portid="80"><state state="open"/><service name="http"/><script id="http-default-accounts" output="admin:D3fault-Acct-55123"/><script id="banner" output="Welcome to sw-a"/></port>
</ports><hostscript><script id="smb-brute" output="guest:Smb-Pw-1234-abcd"/><script id="mysql-creds-x" output="root:My-Pw-1"/><script id="http-auth-finder" output="auth-Pw-9"/></hostscript></host></nmaprun>`;
  const LEAKS = ['Hunt3rTwo-Brute-9981Zq', 'Ftp-Pw-77431-xyz', 'D3fault-Acct-55123', 'Smb-Pw-1234-abcd', 'My-Pw-1', 'auth-Pw-9'];

  it('credential-hunting scripts are dropped at parse time; a plain one stays', () => {
    const raw = readImport(xml, { xml: miniXml });
    const text = JSON.stringify(raw);
    for (const s of LEAKS) expect(text, s).not.toContain(s);
    expect(text).toContain('Welcome to sw-a');
    expect(raw.notes.join(' ')).toMatch(/dropped/);
  });

  it('scan output is not Notes by default (Ignore), and the person may opt in', async () => {
    const table = await gated(readImport(xml, { xml: miniXml }));
    const m = defaultMapping(table, []);
    expect(m[table.headers.indexOf('scan output')]).toEqual({ kind: 'ignore' });
    const { doc } = docWithRack();
    const off = buildPlan(table, m, { doc, catalogue: CATALOGUE, defs: [] });
    expect(JSON.stringify(off.items)).not.toContain('Welcome to sw-a');
    const on = m.map((t, i) => (table.headers[i] === 'scan output' ? ({ kind: 'core', key: 'notes' } as const) : t));
    expect(mappingErrors(table, on, [])).toEqual([]);
    const plan = buildPlan(table, on, { doc, catalogue: CATALOGUE, defs: [] });
    expect(plan.items[0]!.notes.join(' ')).toContain('Welcome to sw-a');
    for (const s of LEAKS) expect(JSON.stringify(plan), s).not.toContain(s);
  });
});

describe('3 · at most 10 new shared fields', () => {
  const cols = Array.from({ length: 13 }, (_, i) => `extra${i}`);
  const csv = `name,${cols.join(',')}\nsw-01,${cols.map((_, i) => `v${i}`).join(',')}\n`;

  it('lists the columns over the cap, and the plan refuses', async () => {
    const table = await gated(read(csv));
    expect(defaultMapping(table, []).some((t) => t.kind === 'new')).toBe(false);
    const mapping = fullMapping(table);
    const errors = mappingErrors(table, mapping, []);
    expect(errors.join(' ')).toMatch(/At most 10 new shared fields/);
    expect(errors.join(' ')).toContain('"extra10", "extra11", "extra12"');
    expect(errors.join(' ')).not.toContain('"extra9"');
    expect(() => buildPlan(table, mapping, { doc: docWithRack().doc, catalogue: CATALOGUE, defs: [] })).toThrow(ImportRefusal);
  });

  it('exactly ten is allowed', async () => {
    const table = await gated(read(csv));
    const mapping = fullMapping(table).map((t, i) => (i > 10 ? ({ kind: 'ignore' } as const) : t));
    expect(mappingErrors(table, mapping, [])).toEqual([]);
    expect(buildPlan(table, mapping, { doc: docWithRack().doc, catalogue: CATALOGUE, defs: [] }).newFields).toHaveLength(10);
  });
});

describe('4 · a Differ row the design has moved under', () => {
  const csv = 'name,serial\nfw-01,NEW-SERIAL\nfw-02,OTHER-NEW\n';

  it('the choice is keyed by device and field, not by row number', async () => {
    const { doc } = docWithRack();
    const d = addDevice(addDevice(doc, 'fw-01', { serial: 'OLD' }), 'fw-02', { serial: 'OLD2' });
    const a = await gated(read(csv));
    const b = await gated(read('name,serial\nfw-02,OTHER-NEW\nfw-01,NEW-SERIAL\n'));
    const pa = buildPlan(a, defaultMapping(a, []), { doc: d, catalogue: CATALOGUE, defs: [] });
    const pb = buildPlan(b, defaultMapping(b, []), { doc: d, catalogue: CATALOGUE, defs: [] });
    const key = (p: typeof pa) => choiceKey(p.items.find((i) => i.name === 'fw-01')!);
    expect(key(pa)).toBe(key(pb));
    expect(pa.items[0]!.row).not.toBe(pb.items.find((i) => i.name === 'fw-01')!.row);
  });

  it('a conflict that changed after the person looked is held back and reported; an unchanged one is applied', async () => {
    const { doc } = docWithRack();
    const seen = addDevice(addDevice(doc, 'fw-01', { serial: 'OLD' }), 'fw-02', { serial: 'OLD2' });
    const table = await gated(read(csv));
    const m = defaultMapping(table, []);
    const shown = buildPlan(table, m, { doc: seen, catalogue: CATALOGUE, defs: [] });
    expect(shown.counts.differ).toBe(2);
    // Meanwhile someone changes fw-01's serial to something else.
    const chassisId = devicesByName(seen).get('fw-01')!.chassisId;
    const moved = setChassisField(seen, chassisId, 'serial', 'CHANGED-BY-A-COLLEAGUE', { actor: ACTOR, now: NOW + 1 });
    const final = buildPlan(table, m, { doc: moved, catalogue: CATALOGUE, defs: [] });
    const held = holdChangedConflicts(shown, final);
    expect(held).toHaveLength(1);
    expect(held[0]).toContain('fw-01');
    const choices = new Map(shown.items.map((i) => [choiceKey(i), 'theirs' as const]));
    const out = await applyPlan(moved, final, { choices, defs: [], fresh: [], actor: ACTOR, now: NOW + 2, label: importLabel(2) });
    const by = devicesByName(out.doc);
    expect(by.get('fw-01')!.serial).toBe('CHANGED-BY-A-COLLEAGUE');
    expect(by.get('fw-02')!.serial).toBe('OTHER-NEW');
  });
});

describe('5 · key collection is linear and capped', () => {
  it('2,000 JSON records of 190 keys each read quickly', () => {
    const rec = (i: number) => `{"name":"h${i}",${Array.from({ length: 189 }, (_, k) => `"k${k}":"1"`).join(',')}}`;
    const text = `[${Array.from({ length: 2000 }, (_, i) => rec(i)).join(',')}]`;
    const t0 = performance.now();
    const raw = readImport(text);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(raw.rows).toHaveLength(2000);
    expect(raw.headers).toHaveLength(LIMITS.columns);
    expect(raw.headers[0]).toBe('name');
  });

  it('2,000 records that each bring 400 keys of their own stop adding keys', () => {
    const recs = Array.from({ length: 2000 }, (_, i) => new Map([['name', `h${i}`], ...Array.from({ length: 400 }, (_, k) => [`u${i}_${k}`, 'v'] as [string, string])]));
    const notes: string[] = [];
    const t0 = performance.now();
    const { headers } = tableOfRecords(recs, notes);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(headers.length).toBeLessThanOrEqual(LIMITS.columns);
    expect(headers).toContain('name');
  });

  it('name is kept even when it first appears after the scan cap', () => {
    const first = new Map(Array.from({ length: 500 }, (_, k) => [`z${k}`, 'v'] as [string, string]));
    const { headers } = tableOfRecords([first, new Map([['name', 'a']])], []);
    expect(headers).toContain('name');
  });
});

describe('6 · the history label', () => {
  it('never holds the file name', async () => {
    expect(importLabel(1)).toBe('import (1 row)');
    expect(importLabel(212)).toBe('import (212 rows)');
    expect(importLabel(5)).not.toMatch(/\.csv|secret/);
    const { doc } = docWithRack();
    const table = await gated(read('name\nsw-01\n'));
    const plan = buildPlan(table, defaultMapping(table, []), { doc, catalogue: CATALOGUE, defs: [] });
    const out = await applyPlan(doc, plan, { defs: [], fresh: [], actor: ACTOR, now: NOW, label: importLabel(1) });
    expect(undoable(out.doc, ACTOR)[0]!.label).toBe('import (1 row)');
  });
});

describe('7 · formulas', () => {
  it('a list element is neutralised after the split, not only the whole cell', async () => {
    const table = await gated(read('name,tags\nsw-01,"core, =HYPERLINK(1);@cmd,＝1+1, -5"\n'));
    const plan = buildPlan(table, defaultMapping(table, []), { doc: docWithRack().doc, catalogue: CATALOGUE, defs: [] });
    expect(plan.items[0]!.tags).toEqual(['core', "'=HYPERLINK(1)", "'@cmd", "'＝1+1", '-5']);
  });

  it('fullwidth leaders and a leader behind invisible characters or spaces count', () => {
    for (const c of ['＝1+1', '＋1', '－1+2', '＠x', '​=1+1', '­@x', '   =1', '⁠+1+1']) {
      expect(neutraliseFormula(c, stripUnsafe(c).trim()).changed, c).toBe(true);
    }
    expect(neutraliseFormula('-5', '-5').changed).toBe(false);
    expect(neutraliseFormula('plain', 'plain').changed).toBe(false);
  });

  it('a whole cell in the gate is still neutralised', async () => {
    const t = await gateTable(read('name,notes\nsw-01,＝cmd\n'), identity);
    expect(t.rows[0]![1]).toBe("'＝cmd");
  });
});

describe('8 · invisible and format characters', () => {
  it('the server deny set is stripped from every stored string', async () => {
    const dirty = 'a­b͏c؜d؀eᅟfᅠg᠎h​i‮j⁦kㅤlm️n﻿oﾠp￹q\u{1D173}r\u{E0041}s\u{F0001}t\u0007u';
    expect(stripUnsafe(dirty)).toBe('abcdefghijklmnopqrstu');
    const t = await gateTable(read(`name,notes\nswㅤ-01,x\u{E0041}y️\n`), identity);
    expect(t.rows[0]).toEqual(['sw-01', 'xy']);
  });

  it('keeps newlines, ordinary Unicode and emoji bodies', () => {
    expect(stripUnsafe('Zürich\n東京 ✓')).toBe('Zürich\n東京 ✓');
  });
});

describe('9 · long JSON numbers', () => {
  it('a serial of more than 15 digits keeps every digit', () => {
    const raw = readImport('[{"name":"a","serial":12345678901234567890,"unit":42,"x":1.5,"y":0.12345678901234567}]');
    const row = Object.fromEntries(raw.headers.map((h, i) => [h, raw.rows[0]![i]]));
    expect(row.serial).toBe('12345678901234567890');
    expect(row.unit).toBe('42');
    expect(row.x).toBe('1.5');
    expect(row.y).toBe('0.12345678901234567');
  });

  it('leaves strings and short numbers alone', () => {
    expect(quoteLongNumbers('{"a":"12345678901234567890","b":123456789012345,"c":-1e3}')).toBe('{"a":"12345678901234567890","b":123456789012345,"c":-1e3}');
    expect(quoteLongNumbers('[-12345678901234567890]')).toBe('["-12345678901234567890"]');
  });
});
