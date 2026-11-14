import { describe, expect, it } from 'vitest';

import type { PlanFields, PlanKind, PlanRecord } from '../api/ipPlan';
import { netboxFiles } from '../components/organisation/ipPlanModel';
import { gateTable } from './gate';
import { applyPlanImport, importCounts, kindOf, planImport } from './ipPlanImport';
import { readImport } from './read';

let n = 0;
const rec = (kind: PlanKind, fields: PlanFields): PlanRecord => ({ id: `01K${String((n += 1)).padStart(23, '0')}`, kind, version: 1, fields, lapsed: false, addresses: null, usable: null });
const passed = (csv: string) => gateTable(readImport(csv), async (t) => t);

describe('NetBox files into the IP plan (ADR-0083 decision 6)', () => {
  it('knows each NetBox list by its columns, as Download for NetBox writes them and as a NetBox table export heads them', () => {
    expect(kindOf(['prefix', 'rir', 'description'])).toBe('aggregate');
    expect(kindOf(['prefix', 'vrf', 'vlan', 'status', 'role', 'is_pool', 'mark_utilized', 'description'])).toBe('prefix');
    expect(kindOf(['Prefix', 'Status', 'VRF', 'Is Pool'])).toBe('prefix');
    expect(kindOf(['Start address', 'End address', 'VRF', 'Status'])).toBe('range');
    expect(kindOf(['address', 'vrf', 'status', 'role', 'dns_name', 'description'])).toBe('address');
    expect(kindOf(['name', 'rd', 'enforce_unique', 'import_targets', 'export_targets', 'description'])).toBe('vrf');
    expect(kindOf(['name', 'slug', 'vid_ranges', 'description'])).toBe('vlan_group');
    expect(kindOf(['group', 'vid', 'name', 'status', 'description'])).toBe('vlan');
    expect(kindOf(['name', 'slug', 'rir', 'start', 'end', 'description'])).toBe('asn_range');
    expect(kindOf(['asn', 'rir', 'description'])).toBe('asn');
    expect(kindOf(['name', 'serial', 'site'])).toBeNull();
  });

  it('reads back what Download for NetBox wrote, every row a match', async () => {
    const cust = rec('vrf', { name: 'CUSTOMER-A', enforce_unique: true });
    const plan = [
      cust,
      rec('aggregate', { prefix: '10.0.0.0/8', rir: 'RFC 1918' }),
      rec('prefix', { prefix: '10.20.0.0/16', status: 'container', is_pool: false, mark_utilised: false }),
      rec('prefix', { prefix: '192.0.2.0/24', vrf: cust.id, status: 'active', is_pool: true, mark_utilised: false, note: 'customer' }),
      rec('range', { range: '10.20.1.100-10.20.1.199', status: 'active', populated: true, mark_utilised: false }),
      rec('address', { address: '10.20.1.1/24', status: 'active', dns_name: 'gw.example.net' }),
    ];
    const tables = await Promise.all(netboxFiles(plan).map((f) => passed(f.csv)));
    const files = planImport(tables, plan);
    expect(files.map((f) => f.kind)).toEqual(['vrf', 'aggregate', 'prefix', 'range', 'address']);
    expect(importCounts(files)).toEqual({ new: 0, match: 6, differ: 0, skip: 0 });
  });

  it('says New, Differ and why a row was not read', async () => {
    const plan = [rec('prefix', { prefix: '10.20.1.0/24', status: 'active', is_pool: false, mark_utilised: false })];
    const [file] = planImport([await passed('Prefix,Status,VRF,Is Pool,Description\n10.20.1.0/24,Deprecated,,,\n10.20.2.0/24,Active,,True,lab\nnot-a-net,Active,,,\n10.20.2.0/24,Active,,,')], plan);
    expect(file?.rows.map((r) => [r.label, r.state, r.says])).toEqual([
      ['10.20.1.0/24', 'differ', 'The file has a different status.'],
      ['10.20.2.0/24', 'new', ''],
      ['not-a-net', 'skip', 'Not read: its prefix is not a network.'],
      ['10.20.2.0/24', 'skip', 'Not read: it is in the files twice.'],
    ]);
    expect(file?.rows[1]?.fields).toEqual({ prefix: '10.20.2.0/24', status: 'active', is_pool: true, mark_utilised: false, note: 'lab' });
  });

  it('makes the new rows in order, naming VRFs, groups and ranges by their ids, and reports what the store refused', async () => {
    const tables = await Promise.all([
      passed('address,vrf,status\n198.51.100.1/24,LAB,active\n198.51.100.2/24,NOPE,active'),
      passed('name,rd,enforce_unique\nLAB,65000:1,true'),
      passed('group,vid,name,status\nCampus,120,users,active'),
      passed('name,slug,vid_ranges\nCampus,campus,"100-199"'),
      passed('name,slug,rir,start,end\nPrivate,private,RFC 6996,64512,65534'),
      passed('asn,rir\n65001,RFC 6996'),
    ]);
    const files = planImport(tables, []);
    const made: Array<[PlanKind, PlanFields]> = [];
    const result = await applyPlanImport(
      files,
      [],
      {
        create: async (kind, fields) => {
          made.push([kind, fields]);
          return rec(kind, fields);
        },
        update: async () => {
          throw new Error('not asked');
        },
      },
      false,
      (e) => String(e),
    );
    expect(made.map(([k]) => k)).toEqual(['vrf', 'vlan_group', 'vlan', 'address', 'asn_range', 'asn']);
    expect(made[3]?.[1].vrf).toMatch(/^01K/);
    expect(made[2]?.[1].group).toMatch(/^01K/);
    expect(made[5]?.[1].range).toMatch(/^01K/);
    expect(result).toEqual({ made: 6, changed: 0, refused: [{ label: '198.51.100.2/24', why: 'The plan has no VRF NOPE; add it, or load VRFs first.' }] });
  });
});
