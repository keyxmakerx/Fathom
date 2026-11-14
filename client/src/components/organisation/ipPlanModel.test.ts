import { describe, expect, it } from 'vitest';

import { cleanFields, parseList, planRefusal, type PlanKind, type PlanRecord } from '../../api/ipPlan';
import { ApiRefusal } from '../../api/errors';
import { addressTree, formatIp, netboxFiles, netboxGaps, parseCidrBig, parseIpv6Big, spanToCidrs, subline, usableWords, usedWords, vrfsInUse } from './ipPlanModel';
import { fieldsFromDraft, heldSlot, wantsFor } from './IpPlanPage';

let n = 0;
const rec = (kind: PlanKind, fields: PlanRecord['fields'], extra: Partial<PlanRecord> = {}): PlanRecord => ({
  id: `01K${String((n += 1)).padStart(23, '0')}`,
  kind,
  version: 1,
  fields,
  lapsed: false,
  addresses: null,
  usable: null,
  ...extra,
});

describe('addresses as numbers, both families', () => {
  it('reads IPv6 with :: and a dotted tail, and writes it back the RFC 5952 way', () => {
    expect(parseIpv6Big('2001:db8::1')).toBe(0x20010db8000000000000000000000001n);
    expect(parseIpv6Big('::ffff:192.0.2.1')).toBe(0xffffc0000201n);
    expect(parseIpv6Big('1::2::3')).toBeUndefined();
    expect(formatIp(true, 0x20010db8000000000000000000000001n)).toBe('2001:db8::1');
    expect(formatIp(true, 0x20010db8000000010000000000000000n)).toBe('2001:db8:0:1::');
    expect(formatIp(false, 0x0a140100n)).toBe('10.20.1.0');
  });

  it('turns a gap into the fewest prefixes, and stops at the limit', () => {
    expect(spanToCidrs(false, 0x0a000008n, 0x0a0000ffn, 9).cidrs).toEqual(['10.0.0.8/29', '10.0.0.16/28', '10.0.0.32/27', '10.0.0.64/26', '10.0.0.128/25']);
    expect(spanToCidrs(false, 0x0a000008n, 0x0a0000ffn, 2)).toEqual({ cidrs: ['10.0.0.8/29', '10.0.0.16/28'], more: true });
    const v6 = parseCidrBig('2001:db8::/48');
    expect(v6 && spanToCidrs(true, v6.lo, v6.hi, 3).cidrs).toEqual(['2001:db8::/48']);
  });
});

describe('the address tree (ADR-0083 decisions 4 and 7)', () => {
  const agg = rec('aggregate', { prefix: '10.0.0.0/8', rir: 'RFC 1918' });
  const site = rec('prefix', { prefix: '10.20.0.0/16', status: 'container', is_pool: false, mark_utilised: false });
  const lan = rec('prefix', { prefix: '10.20.1.0/24', status: 'active', is_pool: false, mark_utilised: false });
  const gw = rec('address', { address: '10.20.1.1/24', status: 'active', meant_for: 'core-sw1 vlan120' });
  const dhcp = rec('range', { range: '10.20.1.100-10.20.1.199', status: 'active', populated: true, mark_utilised: false });
  const wan = rec('reservation', { prefix: '10.20.1.8/29', reason: 'WAN', work: 'W-1042', ends: '2026-12-14' });
  const vrf = rec('vrf', { name: 'CUSTOMER-A', enforce_unique: true });
  const inVrf = rec('prefix', { prefix: '10.20.1.0/24', vrf: vrf.id, status: 'active', is_pool: false, mark_utilised: false });
  const v6 = rec('prefix', { prefix: '2001:db8::/48', status: 'container', is_pool: false, mark_utilised: false });
  const all = [gw, dhcp, wan, lan, site, agg, vrf, inVrf, v6];

  it('nests each record under the smallest block that holds it, in address order, IPv4 first', () => {
    const tree = addressTree(all, '');
    expect(tree.map((r) => [r.record.id, r.depth])).toEqual([
      [agg.id, 0],
      [site.id, 1],
      [lan.id, 2],
      [gw.id, 3],
      [wan.id, 3],
      [dhcp.id, 3],
      [v6.id, 0],
    ]);
    expect(tree.find((r) => r.record.id === lan.id)?.children).toEqual([gw.id, wan.id, dhcp.id]);
  });

  it('keeps a VRF apart: the same prefix in a VRF is not inside the global aggregate', () => {
    expect(addressTree(all, vrf.id).map((r) => r.record.id)).toEqual([inVrf.id]);
    expect(vrfsInUse(all)).toEqual(['', vrf.id]);
  });

  it('counts a block’s use from what is inside it and writes out the free stretches', () => {
    const lanRow = addressTree(all, '').find((r) => r.record.id === lan.id);
    expect(lanRow && usedWords(lanRow)).toBe(`${1 + 8 + 100} of 256 used`);
    expect(lanRow?.free).toEqual(['10.20.1.0/32', '10.20.1.2/31', '10.20.1.4/30']);
    expect(lanRow?.freeMore).toBe(true);
    const aggRow = addressTree(all, '').find((r) => r.record.id === agg.id);
    expect(aggRow && usedWords(aggRow)).toBe('1% used');
  });

  it('counts a block marked utilised, or a populated range, as full', () => {
    const full = rec('prefix', { prefix: '192.0.2.0/24', status: 'active', is_pool: false, mark_utilised: true });
    const row = addressTree([full], '')[0];
    expect(row.percent).toBe(100);
    expect(row.free).toEqual([]);
    expect(addressTree(all, '').find((r) => r.record.id === dhcp.id)?.percent).toBe(100);
  });

  it('lists a record it cannot read last, rather than dropping it', () => {
    const odd = rec('prefix', { prefix: 'not an address', status: 'active', is_pool: false, mark_utilised: false });
    const tree = addressTree([odd, lan], '');
    expect(tree.map((r) => r.record.id)).toEqual([lan.id, odd.id]);
  });

  it('says who holds a reservation, and that it lapsed', () => {
    const mine = rec('reservation', { address: '10.20.1.9', reason: 'test', holder: 'acct-1', ends: '2026-01-01' }, { lapsed: true });
    expect(subline(mine, new Map(), 'acct-1')).toBe('Reserved for you until 2026-01-01 · lapsed');
    expect(subline(wan, new Map(), null)).toBe('Reserved for W-1042 until 2026-12-14');
    const someone = rec('reservation', { address: '10.20.1.9', reason: 'test', holder: 'acct-2', ends: '2026-12-01' });
    expect(subline(someone, new Map([['acct-2', 'Ana']]), 'acct-1')).toContain('Ana');
  });

  it('says how the usable count is worked out', () => {
    expect(usableWords(rec('prefix', { prefix: '10.0.0.0/29', status: 'active' }, { addresses: '8', usable: '6' }))).toBe('8 addresses, 6 usable without the network and broadcast addresses');
    expect(usableWords(rec('prefix', { prefix: '10.0.0.0/29', status: 'active', is_pool: true }, { addresses: '8', usable: '8' }))).toContain('pool');
  });
});

describe('NetBox files (decision 6)', () => {
  const rt = rec('route_target', { value: '65000:100' });
  const vrf = rec('vrf', { name: 'CUSTOMER-A', route_distinguisher: '65000:1', enforce_unique: true, import_targets: [rt.id], export_targets: [rt.id], note: 'Says "hi", twice' });
  const agg = rec('aggregate', { prefix: '10.0.0.0/8' });
  const pfx = rec('prefix', { prefix: '10.20.1.0/24', vrf: vrf.id, status: 'active', role: 'Users', vlan: '120', is_pool: false, mark_utilised: false });
  const res = rec('reservation', { address: '10.20.1.9', reason: 'Printer', work: 'W-7', ends: '2026-12-01' });
  const range = rec('asn_range', { name: 'Private 4-byte', first: '4200000000', last: '4200000999', rir: 'RFC 6996' });
  const asn = rec('asn', { asn: '4200000001', range: range.id, meant_for: 'Branch 12' });

  it('writes NetBox’s own import columns, names what a record links to, and quotes what needs it', () => {
    const files = netboxFiles([rt, vrf, agg, pfx, res, range, asn]);
    expect(files.map((f) => f.name)).toEqual(['route-targets.csv', 'vrfs.csv', 'aggregates.csv', 'prefixes.csv', 'ip-addresses.csv', 'asn-ranges.csv', 'asns.csv']);
    const vrfs = files.find((f) => f.name === 'vrfs.csv')?.csv;
    expect(vrfs).toBe('name,rd,enforce_unique,import_targets,export_targets,description\r\nCUSTOMER-A,65000:1,true,65000:100,65000:100,"Says ""hi"", twice"\r\n');
    expect(files.find((f) => f.name === 'prefixes.csv')?.csv).toContain('10.20.1.0/24,CUSTOMER-A,120,active,Users,false,false,');
    expect(files.find((f) => f.name === 'ip-addresses.csv')?.csv).toContain('10.20.1.9/32,,reserved,,,"Printer, W-7, until 2026-12-01"');
    expect(files.find((f) => f.name === 'asns.csv')?.csv).toContain('4200000001,RFC 6996,Branch 12');
    expect(files.find((f) => f.name === 'asn-ranges.csv')?.csv).toContain('Private 4-byte,private-4-byte,RFC 6996,4200000000,4200000999,');
  });

  it('says what NetBox would refuse before anyone downloads', () => {
    expect(netboxGaps([agg])).toEqual(['1 aggregate has no RIR, which NetBox needs.']);
    expect(netboxGaps([rec('asn', { asn: '65001' })])).toEqual(['1 ASN has no RIR from a range, which NetBox needs.']);
  });
});

describe('the wire', () => {
  it('reads the list answer and the store’s refusal sentence', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ records: [{ id: '01K00000000000000000000001', kind: 'prefix', version: 2, fields: { prefix: '10.0.0.0/29', is_pool: false }, addresses: '8', usable: '6' }], today: '2026-11-14' }),
    );
    const list = parseList(bytes);
    expect(list.records[0]).toMatchObject({ kind: 'prefix', version: 2, addresses: '8', usable: '6', lapsed: false });
    expect(planRefusal(new ApiRefusal(409, '{"error":"that network is already in this VRF"}', null))).toBe('that network is already in this VRF');
    expect(planRefusal(new ApiRefusal(403, 'not authorised', null))).toBeNull();
  });

  it('sends no empty optional field, and keeps what the form does not show', () => {
    expect(cleanFields({ a: ' x ', b: '', c: false, d: ['', ' y '], e: null })).toEqual({ a: 'x', c: false, d: ['y'] });
    const held = rec('reservation', { prefix: '10.0.0.8/29', reason: 'WAN', ends: '2026-12-01', allocation_key: 'W-1/wan', parent: 'p', holder: 'acct-1' });
    const out = fieldsFromDraft('reservation', { held: '10.0.0.8/29', reason: 'WAN link', work: '', ends: '2026-12-01', vrf: '', dns_name: '', folder: '', note: '' }, held);
    expect(out).toEqual({ prefix: '10.0.0.8/29', reason: 'WAN link', ends: '2026-12-01', allocation_key: 'W-1/wan', parent: 'p', holder: 'acct-1' });
    expect(fieldsFromDraft('vlan_group', { name: 'Campus', vid_ranges: '100-199, 300-399' } as never, null)).toEqual({ name: 'Campus', vid_ranges: ['100-199', '300-399'] });
  });

  it('puts a typed reservation in the right slot, and offers next free only where the store gives it', () => {
    expect([heldSlot('10.0.0.8/29'), heldSlot('10.0.0.1-10.0.0.9'), heldSlot('10.0.0.9')]).toEqual(['prefix', 'range', 'address']);
    expect(wantsFor(rec('prefix', {}))).toEqual(['prefix', 'address']);
    expect(wantsFor(rec('range', {}))).toEqual(['address']);
    expect(wantsFor(rec('address', {}))).toEqual([]);
  });
});
