import { describe, expect, it } from 'vitest';

import { connectPorts } from './cables';
import { addSketchPort, createSketchDevice } from './commands';
import { setDeviceField, setPortMac } from './edit';
import { acceptHosts, looksLikeMacTable, readAddresses, readArp, readLeases, readMacTable, suggestHosts } from './hosts';
import { asString, edgesIn, emptyDocument, fieldValue, parseNodeId, readPhysicalPortFields, type Document } from './model';
import { undo } from './undo';

const OPTS = { now: 1_700_000_000_000, actor: 'test' };

function box(doc: Document, hostname: string, labels: string[]): { doc: Document; deviceId: string; chassisId: string; ports: string[] } {
  const had = new Set(doc.nodes.map((n) => n.id));
  let d = createSketchDevice(doc, { ...OPTS, hostname });
  const fresh = d.nodes.filter((n) => !had.has(n.id));
  const chassisId = fresh.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
  const deviceId = fresh.find((n) => parseNodeId(n.id).kind === 'Device')!.id;
  const ports: string[] = [];
  for (const label of labels) {
    const before = new Set(d.nodes.map((n) => n.id));
    d = addSketchPort(d, chassisId, { label, connector: 'rj45', face: 'front' }, OPTS);
    ports.push(d.nodes.find((n) => !before.has(n.id) && parseNodeId(n.id).kind === 'PhysicalPort')!.id);
  }
  return { doc: d, deviceId, chassisId, ports };
}

// The shapes of the vendor samples cited in hosts.ts, with this test's own addresses.
const IOS = `Mac Address Table
-------------------------------------------

Vlan    Mac Address       Type        Ports
----    -----------       --------    -----
 100    9c54.1631.8bd1    DYNAMIC     Gi1/0/5
 100    706b.b929.f751    STATIC      Vl100
 100    0001.e643.91a9    DYNAMIC     Gi1/0/7
 200    000a.b837.b5dd    DYNAMIC     Gi1/0/24
 200    000f.206f.dc5d    DYNAMIC     Gi1/0/24
 100    000f.fe84.bb73    DYNAMIC     Gi1/0/9
Total Mac Addresses for this criterion: 6
`;

const NXOS = `Legend:
        * - primary entry, G - Gateway MAC, (R) - Routed MAC, O - Overlay MAC
   VLAN     MAC Address      Type      age     Secure NTFY Ports
---------+-----------------+--------+---------+------+----+------------------
*    8     f44e.0584.7ffc   dynamic  0         F      F    Eth1/39
*   50     f44e.0584.7ffd   dynamic  0         F      F    Po47
`;

const JUNOS = `Ethernet-switching table: 5 entries, 2 learned, 0 persistent
  VLAN              MAC address       Type         Age Interfaces
  F2                *                 Flood          - All-members
  F2                00:00:05:00:00:03 Learn          0 ge-0/0/44.0
  F2                00:19:e2:50:7d:e0 Static         - Router
`;

const IOS_ARP = `Protocol  Address       Age(min)Hardware Addr  Type Interface
Internet  192.168.10.20 9       9c54.1631.8bd1 ARPA Vlan100
Internet  192.168.10.31 8       0001.e643.91a9 ARPA Vlan100
`;

const JUNOS_ARP = `MAC Address       Address         Name                     Interface
00:00:05:00:00:03 192.168.64.10   firewall.my.net          fxp0.0
00:04:5a:65:78:e1 192.168.65.13   192.168.65.13            fxp0.0
`;

const NEIGH = `192.168.10.20 dev br0 lladdr 9c:54:16:31:8b:d1 REACHABLE
192.168.10.99 dev br0 FAILED
fe80::1 dev br0 lladdr 00:01:e6:43:91:a9 router STALE
`;

describe('reading MAC tables', () => {
  it('reads Cisco IOS rows and drops the switch itself', () => {
    const t = readMacTable(IOS)!;
    expect(t.format).toBe('cisco');
    expect(t.rows.map((r) => `${r.vlan} ${r.mac} ${r.port}`)).toEqual([
      '100 9c:54:16:31:8b:d1 Gi1/0/5',
      '100 00:01:e6:43:91:a9 Gi1/0/7',
      '200 00:0a:b8:37:b5:dd Gi1/0/24',
      '200 00:0f:20:6f:dc:5d Gi1/0/24',
      '100 00:0f:fe:84:bb:73 Gi1/0/9',
    ]);
  });

  it('reads NX-OS rows under their legend', () => {
    expect(readMacTable(NXOS)!.rows.map((r) => r.port)).toEqual(['Eth1/39', 'Po47']);
  });

  it('reads Junos rows and skips the flood and Router entries', () => {
    const t = readMacTable(JUNOS)!;
    expect(t.format).toBe('junos');
    expect(t.rows).toEqual([{ vlan: 'F2', mac: '00:00:05:00:00:03', port: 'ge-0/0/44.0' }]);
  });

  it('is not fooled by a config or an LLDP list', () => {
    expect(looksLikeMacTable('set interfaces ge-0/0/1 description uplink\n')).toBe(false);
    expect(looksLikeMacTable('Local Interface    Chassis Id          Port info     System Name\nge-0/0/1  00:00:5e:00:53:01  ether2  router-1\n')).toBe(false);
  });
});

describe('reading ARP tables', () => {
  it('reads Cisco show ip arp', () => {
    expect(readArp(IOS_ARP)).toEqual([
      { ip: '192.168.10.20', mac: '9c:54:16:31:8b:d1' },
      { ip: '192.168.10.31', mac: '00:01:e6:43:91:a9' },
    ]);
  });

  it('reads Junos show arp with its names, and no name when Junos prints the address again', () => {
    expect(readArp(JUNOS_ARP)).toEqual([
      { ip: '192.168.64.10', mac: '00:00:05:00:00:03', name: 'firewall.my.net' },
      { ip: '192.168.65.13', mac: '00:04:5a:65:78:e1' },
    ]);
  });

  it('reads ip neigh and skips a line with no link-layer address', () => {
    expect(readArp(NEIGH)).toEqual([
      { ip: '192.168.10.20', mac: '9c:54:16:31:8b:d1' },
      { ip: 'fe80::1', mac: '00:01:e6:43:91:a9' },
    ]);
  });
});

describe('suggesting devices and cables', () => {
  const sw = box(emptyDocument(), 'sw-core', ['Gi1/0/5', 'Gi1/0/7', 'Gi1/0/9', 'Gi1/0/24']);
  const nas = box(sw.doc, 'nas', ['eth0']);
  const withMac = setPortMac(nas.doc, nas.ports[0]!, '000f.fe84.bb73', OPTS);
  const table = readMacTable(IOS)!;
  const arp = readArp(IOS_ARP);

  it('names a new device from ARP, cables a port drawn with the MAC, and leaves a busy port', () => {
    const rows = suggestHosts(withMac, sw.chassisId, table, arp);
    const by = new Map(rows.map((r) => [r.port, r]));
    expect(by.get('Gi1/0/5')).toMatchObject({ kind: 'new', state: 'ready', name: 'host-192-168-10-20', ip: '192.168.10.20' });
    expect(by.get('Gi1/0/9')).toMatchObject({ kind: 'cable', state: 'ready', name: 'nas', remotePortId: nas.ports[0] });
    expect(by.get('Gi1/0/24')).toMatchObject({ state: 'several' });
    expect(by.get('Gi1/0/24')!.why).toContain('another switch or an access point');
  });

  it('leaves a port the design has not drawn', () => {
    const t = readMacTable(JUNOS)!;
    const rows = suggestHosts(withMac, sw.chassisId, t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'no-port' });
  });

  it('does not invent a device behind a port that already has a cable', () => {
    const other = box(withMac, 'pc', ['1']);
    const cabled = connectPorts(other.doc, sw.ports[0]!, other.ports[0]!, {}, OPTS);
    const r = suggestHosts(cabled, sw.chassisId, table, arp).find((s) => s.port === 'Gi1/0/5')!;
    expect(r.state).toBe('busy');
  });

  it('points at a drawn device that has the address but not the MAC', () => {
    const at = setDeviceField(withMac, nas.deviceId, 'management_address', '192.168.10.31', OPTS);
    const r = suggestHosts(at, sw.chassisId, table, arp).find((s) => s.port === 'Gi1/0/7')!;
    expect(r.state).toBe('known');
    expect(r.why).toContain('nas has the address 192.168.10.31');
  });

  it('writes the ticked ones as one undo step', () => {
    const rows = suggestHosts(withMac, sw.chassisId, table, arp);
    const keys = new Set(rows.filter((r) => r.state === 'ready').map((r) => r.key));
    const next = acceptHosts(withMac, sw.chassisId, table, arp, keys, { x: 40, y: 400 }, OPTS);
    expect(next.batches.length).toBe(withMac.batches.length + 1);
    expect(next.batches.at(-1)!.label).toBe('devices from MAC table');

    const made = next.nodes.filter((n) => parseNodeId(n.id).kind === 'Device' && !withMac.nodes.some((m) => m.id === n.id));
    expect(made.map((n) => asString(fieldValue(n.fields, 'Device.hostname'))).sort()).toEqual(['host-192-168-10-20', 'host-192-168-10-31']);
    const first = made.find((n) => asString(fieldValue(n.fields, 'Device.hostname')) === 'host-192-168-10-20')!;
    expect(asString(fieldValue(first.fields, 'Device.management_address'))).toBe('192.168.10.20');
    const port = next.nodes.find((n) => parseNodeId(n.id).kind === 'PhysicalPort' && readPhysicalPortFields(n).mac === '9c:54:16:31:8b:d1')!;
    expect(edgesIn(next, port.id, 'Terminates')).toHaveLength(1);
    expect(edgesIn(next, nas.ports[0]!, 'Terminates')).toHaveLength(1);

    const back = undo(next, next.batches.at(-1)!.id, OPTS);
    expect(back.nodes.filter((n) => n.absentSince === undefined).length).toBe(withMac.nodes.filter((n) => n.absentSince === undefined).length);
  });

  it('writes nothing for an unticked row', () => {
    const next = acceptHosts(withMac, sw.chassisId, table, arp, new Set(), { x: 0, y: 0 }, OPTS);
    expect(next.nodes.length).toBe(withMac.nodes.length);
  });
});

// The shapes of the lease files cited in hosts.ts, with this test's own addresses.
const ISC = `# The format of this file is documented in the dhcpd.leases(5) manual page.
lease 192.168.10.20 {
  starts 4 2026/10/22 09:00:00;
  ends 4 2026/10/22 21:00:00;
  hardware ethernet 9c:54:16:31:8b:d1;
  client-hostname "old-name";
}
lease 192.168.10.20 {
  starts 5 2026/10/23 09:00:00;
  hardware ethernet 9c:54:16:31:8b:d1;
  uid "nas-uid";
  client-hostname "nas";
}
lease 192.168.10.40 {
  hardware ethernet 00:0f:fe:84:bb:73;
}
`;

const DNSMASQ = `1792900000 9c:54:16:31:8b:d1 192.168.10.20 nas 01:9c:54:16:31:8b:d1
1792900100 00:01:e6:43:91:a9 192.168.10.31 * *
`;

const KEA = `address,hwaddr,client_id,valid_lifetime,expire,subnet_id,fqdn_fwd,fqdn_rev,hostname,state,user_context
192.168.10.20,9c:54:16:31:8b:d1,,4000,1792900000,1,1,1,nas.home.arpa.,0,
192.168.10.31,00:01:e6:43:91:a9,,4000,1792900000,1,0,0,,0,
`;

describe('reading DHCP leases', () => {
  it('reads ISC dhcpd leases, the last declaration of an address current, quotes taken off', () => {
    expect(readLeases(ISC)).toEqual([
      { ip: '192.168.10.20', mac: '9c:54:16:31:8b:d1', name: 'nas' },
      { ip: '192.168.10.40', mac: '00:0f:fe:84:bb:73' },
    ]);
  });

  it('reads dnsmasq leases, and no name for *', () => {
    expect(readLeases(DNSMASQ)).toEqual([
      { ip: '192.168.10.20', mac: '9c:54:16:31:8b:d1', name: 'nas' },
      { ip: '192.168.10.31', mac: '00:01:e6:43:91:a9' },
    ]);
  });

  it('reads Kea CSV by its header', () => {
    expect(readLeases(KEA)).toEqual([
      { ip: '192.168.10.20', mac: '9c:54:16:31:8b:d1', name: 'nas.home.arpa' },
      { ip: '192.168.10.31', mac: '00:01:e6:43:91:a9' },
    ]);
  });

  it('does not read a MAC table or an ARP table as leases', () => {
    expect(readLeases(IOS)).toEqual([]);
    expect(readLeases(IOS_ARP)).toEqual([]);
  });

  it('names a new device from a lease, keeping the ARP address', () => {
    const sw = box(emptyDocument(), 'sw-core', ['Gi1/0/5']);
    const rows = suggestHosts(sw.doc, sw.chassisId, readMacTable(IOS)!, readAddresses(IOS_ARP + '\n' + DNSMASQ));
    expect(rows.find((r) => r.port === 'Gi1/0/5')).toMatchObject({ kind: 'new', state: 'ready', name: 'nas', ip: '192.168.10.20' });
  });

  it('takes the name before the first dot from a fully qualified lease name', () => {
    const sw = box(emptyDocument(), 'sw-core', ['Gi1/0/5']);
    const rows = suggestHosts(sw.doc, sw.chassisId, readMacTable(IOS)!, readLeases(KEA));
    expect(rows.find((r) => r.port === 'Gi1/0/5')!.name).toBe('nas');
  });
});
