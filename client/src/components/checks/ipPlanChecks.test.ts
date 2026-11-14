import { describe, expect, it } from 'vitest';

import type { PlanKind, PlanRecord } from '../../api/ipPlan';
import { addSketchPort, createSketchDevice } from '../../document/commands';
import { emptyDocument, parseNodeId, type Document } from '../../document/model';
import { addSubnet } from '../../document/networks';
import { drawnFacts, ipPlanFindings, sameIp, uniqueSpaceIps, type DrawnAddress, type DrawnFacts } from './ipPlanChecks';
import { plannedWords } from './PlannedMark';

let n = 0;
const rec = (kind: PlanKind, fields: PlanRecord['fields']): PlanRecord => ({
  id: `01K${String((n += 1)).padStart(23, '0')}`,
  kind,
  version: 1,
  fields,
  lapsed: false,
  addresses: null,
  usable: null,
});

const agg = rec('aggregate', { prefix: '10.0.0.0/8', rir: 'RFC 1918' });
const site = rec('prefix', { prefix: '10.20.0.0/16', status: 'container', is_pool: false, mark_utilised: false });
const lan = rec('prefix', { prefix: '10.20.1.0/24', status: 'active', is_pool: false, mark_utilised: false });
const loops = rec('prefix', { prefix: '10.20.255.0/24', status: 'active', is_pool: true, mark_utilised: false });
const gw = rec('address', { address: '10.20.1.1/24', status: 'active', meant_for: 'core-sw1 vlan120' });
const wan = rec('reservation', { prefix: '10.20.9.0/29', reason: 'WAN', work: 'W-1042', ends: '2026-12-14' });
const cust = rec('vrf', { name: 'CUSTOMER-A', enforce_unique: true });
const custNet = rec('prefix', { prefix: '192.0.2.0/24', vrf: cust.id, status: 'active', is_pool: false, mark_utilised: false });
const range = rec('asn_range', { name: 'Private 4-byte', first: '4200000000', last: '4200000999', rir: 'RFC 6996' });
const asn = rec('asn', { asn: '4200000000', range: range.id, meant_for: 'edge' });
const plan = [agg, site, lan, loops, gw, wan, cust, custNet, range, asn];

const addr = (deviceName: string, value: string, over: Partial<DrawnAddress> = {}): DrawnAddress => ({
  addressNodeId: `address:${deviceName}:${value}`,
  value,
  deviceId: `device:${deviceName}`,
  deviceName,
  interfaceLabel: 'ge-0/0/0',
  instance: null,
  ...over,
});
const facts = (addresses: DrawnAddress[], extra: Partial<DrawnFacts> = {}): DrawnFacts => ({
  addresses,
  asns: [],
  devices: [{ id: 'device:core-sw1', name: 'core-sw1' }],
  ...extra,
});
const rules = (f: DrawnFacts, records = plan) => ipPlanFindings(f, records).map((x) => x.rule);

describe('the difference checks between a design and the IP plan (ADR-0083 decision 2)', () => {
  it('says nothing when the organisation has no plan, so a design behaves as before', () => {
    expect(ipPlanFindings(facts([addr('core-sw1', '172.16.0.1/24')]), [])).toEqual([]);
  });

  it('says nothing when the drawing matches: a planned address, a planned prefix, a reservation, a loopback in a pool', () => {
    const f = facts([
      addr('core-sw1', '10.20.1.1/24'),
      addr('sw2', '10.20.1.7/24'),
      addr('edge', '10.20.9.1/29'),
      addr('core-sw1', '10.20.255.1/32'),
      addr('cust-pe', '192.0.2.1/24', { instance: 'CUSTOMER-A' }),
      addr('core-sw1', '127.0.0.1/8'),
      addr('core-sw1', 'fe80::1/64'),
    ]);
    expect(ipPlanFindings(f, plan)).toEqual([]);
  });

  it('warns when an address is drawn with a different length than the plan', () => {
    const [f] = ipPlanFindings(facts([addr('core-sw1', '10.20.1.1/24'), addr('sw2', '10.20.1.9/25')]), plan);
    expect(f).toMatchObject({ rule: 'ip-plan.different-length', severity: 'warn', title: 'sw2 ge-0/0/0 has 10.20.1.9/25, but the plan says 10.20.1.0/24' });
    expect(f?.elements[0]).toEqual({ id: 'device:sw2', name: 'sw2 ge-0/0/0' });
    expect(rules(facts([addr('core-sw1', '10.20.1.1/23')]))).toEqual(['ip-plan.different-length']);
  });

  it('a host address in a prefix that is not a pool is a different length', () => {
    expect(rules(facts([addr('core-sw1', '10.20.1.1/24'), addr('sw2', '10.20.1.50/32')]))).toEqual(['ip-plan.different-length']);
  });

  it('warns when an address is drawn in a different VRF than the plan', () => {
    const [f] = ipPlanFindings(facts([addr('core-sw1', '10.20.1.1/24'), addr('pe', '192.0.2.9/24')]), plan);
    expect(f).toMatchObject({ rule: 'ip-plan.different-vrf', title: '192.0.2.9 is drawn in Global table but planned in CUSTOMER-A' });
  });

  it('notes a network nothing in the plan holds, once per network, and says where it would go', () => {
    const found = ipPlanFindings(facts([addr('core-sw1', '10.20.1.1/24'), addr('a', '10.20.7.1/24'), addr('b', '10.20.7.2/24'), addr('c', '172.16.0.1/24')]), plan);
    expect(found.map((f) => f.title)).toEqual(['10.20.7.0/24 is drawn here but is not in the IP plan', '172.16.0.0/24 is drawn here but is not in the IP plan']);
    expect(found[0]).toMatchObject({ severity: 'idea', fix: 'Add 10.20.7.0/24 under 10.20.0.0/16 in Steward › IP plan.' });
    expect(found[0]?.why).toContain('2 addresses in 10.20.7.0/24 are drawn on a, b');
    expect(found[1]?.fix).toBe('Add 172.16.0.0/24 in Steward › IP plan, or check the address is right.');
  });

  it('notes a VRF the plan does not have, and reads a default table as the global one', () => {
    expect(rules(facts([addr('core-sw1', '10.20.1.1/24'), addr('pe', '10.9.0.1/24', { instance: 'LAB' })]))).toEqual(['ip-plan.vrf-not-planned']);
    expect(rules(facts([addr('core-sw1', '10.20.1.1/24', { instance: 'default' })]))).toEqual([]);
  });

  it('notes an address planned for a device in this design that is not drawn on it', () => {
    const [f] = ipPlanFindings(facts([]), plan);
    expect(f).toMatchObject({
      rule: 'ip-plan.not-drawn',
      title: '10.20.1.1/24 is planned for core-sw1 but is not drawn on it',
      fix: 'Add 10.20.1.1/24 to vlan120 on core-sw1, or change the plan in Steward › IP plan.',
    });
    expect(ipPlanFindings(facts([], { devices: [{ id: 'device:other', name: 'other' }] }), plan)).toEqual([]);
  });

  it('notes a BGP AS number inside a planned range that the plan does not hold', () => {
    const asns = [
      { asn: '4200000000', deviceId: 'device:edge', deviceName: 'edge' },
      { asn: '4200000007', deviceId: 'device:br12', deviceName: 'br12' },
      { asn: '65001', deviceId: 'device:lab', deviceName: 'lab' },
    ];
    const found = ipPlanFindings(facts([addr('core-sw1', '10.20.1.1/24')], { asns }), plan);
    expect(found.map((f) => f.title)).toEqual(['AS 4200000007 on br12 is in Private 4-byte but is not in the IP plan']);
  });

  it('reads the addresses, devices and their interfaces out of a design', () => {
    let doc: Document = emptyDocument();
    let tick = 0;
    const at = () => ({ now: 1_700_000_000_000 + (tick += 1) * 1000 });
    doc = createSketchDevice(doc, { hostname: 'core-sw1', ...at() });
    const chassis = doc.nodes.find((x) => parseNodeId(x.id).kind === 'Chassis')!.id;
    const before = new Set(doc.nodes.map((x) => x.id));
    doc = addSketchPort(doc, chassis, { label: 'ge-0/0/1', connector: 'rj45', face: 'front' }, at());
    const port = doc.nodes.find((x) => !before.has(x.id) && parseNodeId(x.id).kind === 'PhysicalPort')!.id;
    doc = addSubnet(doc, { prefix: '10.20.7.0/24', attach: [{ target: { kind: 'port', portId: port, interfaceName: 'vlan120' }, address: '10.20.7.1/24' }] }, at());
    const got = drawnFacts(doc);
    expect(got.devices.map((d) => d.name)).toEqual(['core-sw1']);
    expect(got.addresses).toMatchObject([{ value: '10.20.7.1/24', deviceName: 'core-sw1', instance: null }]);
    expect(ipPlanFindings(got, plan).map((f) => f.rule)).toEqual(['ip-plan.not-planned', 'ip-plan.not-drawn']);
  });

  it('warns when an address the plan holds in the global table is drawn in another design too', () => {
    const f = facts([addr('core-sw1', '10.20.1.1/24'), addr('sw2', '10.20.1.7/24'), addr('pe', '192.0.2.1/24', { instance: 'CUSTOMER-A' }), addr('c', '172.16.0.1/24')]);
    // Only global-table addresses the plan holds are asked about: not the VRF one, not 172.16/12.
    expect(uniqueSpaceIps(f, plan)).toEqual(['10.20.1.1', '10.20.1.7']);
    const elsewhere = new Map([['10.20.1.7', [{ design: 'd2', designName: 'Branch 12', device: 'br12-sw1' }]]]);
    const found = ipPlanFindings(f, plan, elsewhere).filter((x) => x.rule === 'ip-plan.in-use-twice');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'warn', title: '10.20.1.7 on sw2 is also drawn on br12-sw1 in Branch 12' });
    expect(found[0]?.elements[0]).toEqual({ id: 'device:sw2', name: 'sw2 ge-0/0/0' });
  });

  it('leaves an address the plan shares by role, such as a VRRP address, alone', () => {
    const vip = rec('address', { address: '10.20.1.254/24', status: 'active', role: 'vrrp' });
    const f = facts([addr('core-sw1', '10.20.1.1/24'), addr('sw2', '10.20.1.254/24')]);
    expect(uniqueSpaceIps(f, [...plan, vip])).toEqual(['10.20.1.1']);
    const elsewhere = new Map([['10.20.1.254', [{ design: 'd2', designName: null, device: 'sw9' }]]]);
    expect(ipPlanFindings(f, [...plan, vip], elsewhere).map((x) => x.rule)).toEqual([]);
  });

  it('reads two spellings of one IPv6 address as the same', () => {
    expect(sameIp('2001:DB8::1', '2001:db8:0:0::1/64')).toBe(true);
    expect(sameIp('10.0.0.1', '10.0.0.10')).toBe(false);
  });

  it('says what Adopt would add: the drawn network under its parent, a VRF, an AS number', () => {
    const site2 = rec('prefix', { prefix: '10.20.0.0/16', status: 'container', is_pool: false, mark_utilised: false, folder: 'scope-1' });
    const f = facts([addr('core-sw1', '10.20.1.1/24'), addr('a', '10.20.7.1/24'), addr('pe', '10.9.0.1/24', { instance: 'LAB' })], {
      asns: [{ asn: '4200000007', deviceId: 'device:br12', deviceName: 'br12' }],
    });
    const found = ipPlanFindings(f, [...plan.filter((r) => r !== site), site2]);
    const by = (rule: string) => found.find((x) => x.rule === rule);
    expect(by('ip-plan.not-planned')?.adopt).toEqual({
      kind: 'prefix',
      fields: { prefix: '10.20.7.0/24', status: 'active', is_pool: false, mark_utilised: false, note: 'Adopted from a.', folder: 'scope-1' },
    });
    expect(by('ip-plan.vrf-not-planned')?.adopt).toMatchObject({ kind: 'vrf', fields: { name: 'LAB', enforce_unique: false } });
    expect(by('ip-plan.asn-not-planned')?.adopt).toEqual({ kind: 'asn', fields: { asn: '4200000007', range: range.id, meant_for: 'br12' } });
    // Every finding has its own key for Ignore.
    const keys = found.map((x) => x.ignoreKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('marks a planned address on the device it is meant for, and words the tag', () => {
    const [f] = ipPlanFindings(facts([]), plan);
    expect(f?.mark).toEqual({ deviceId: 'device:core-sw1', address: '10.20.1.1/24', meant: 'core-sw1 vlan120' });
    expect(plannedWords([f!.mark!])).toEqual({ tag: 'PLAN 10.20.1.1/24', title: '10.20.1.1/24 is planned for "core-sw1 vlan120" in the IP plan and is not drawn here yet.' });
    expect(plannedWords([f!.mark!, { ...f!.mark!, address: '10.20.2.1/24' }]).tag).toBe('PLAN 10.20.1.1/24 +1');
  });
});

