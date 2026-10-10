import { describe, expect, it } from 'vitest';

import { connectPorts } from './cables';
import { addSketchPort, createSketchDevice } from './commands';
import { addEdge, addNode, begin, finish } from './freeform';
import { edgesIn, emptyDocument, interfaceName, parseNodeId, token, type Document } from './model';
import { acceptSuggestions, deviceNamed, looksLikeNeighbours, portNamed, readNeighbours, suggestCables } from './neighbours';
import { undo } from './undo';

const NOW = 1_700_000_000_000;
const OPTS = { now: NOW, actor: 'test' };

// The table shapes as the vendor pages print them (read 2026-10-10; sources in neighbours.ts).
const JUNOS = `user@switch> show lldp neighbors
Local Interface   Parent Interface   Chassis Id          Port info    System Name
xe-3/0/4.0        ae31.0             b0:c6:9a:63:80:40   xe-0/0/0.0   newyork31
xe-3/0/5.0        ae31.0             b0:c6:9a:63:80:40   xe-0/0/1.0   newyork31
`;

const CISCO = `Capability codes:
    (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device
    (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other

Device ID           Local Intf     Hold-time  Capability      Port ID
R2                  Gig0/0         120        R               Gig0/0

Total entries displayed: 1
`;

const ARISTA = `Last table change time   : 0:12:33 ago
Number of table inserts  : 33
Number of table deletes  : 0
Number of table drops    : 0
Number of table age-outs : 0

    Port      Neighbor Device ID             Neighbor Port ID      TTL
Et3/1     tg104.sjc.aristanetworks.com   Ethernet3/2           120

    Ma1/1     dc1-rack11-tor1.sjc            1/1                   120
`;

const LLDPD = `-------------------------------------------------------------------------------
LLDP neighbors:
-------------------------------------------------------------------------------
Interface:    eth0, via: LLDP, RID: 1, Time: 0 day, 17:38:08
  Chassis:
    ChassisID:    mac 44:38:39:00:12:9b
    SysName:      PIONEERMS22
    MgmtIP:       192.168.0.22
  Port:
    PortID:       ifname swp47
    PortDescr:    swp47
-------------------------------------------------------------------------------
`;

describe('reading a neighbour list', () => {
  it('reads Junos, dropping nothing but the prompt', () => {
    expect(readNeighbours(JUNOS)).toEqual({
      format: 'junos',
      rows: [
        { local: 'xe-3/0/4.0', name: 'newyork31', port: 'xe-0/0/0.0' },
        { local: 'xe-3/0/5.0', name: 'newyork31', port: 'xe-0/0/1.0' },
      ],
    });
  });

  it('reads Junos without the Parent Interface column, and a far port given as a description', () => {
    const text = `Local Interface    Chassis Id          Port info          System Name
ge-0/0/1           00:11:22:33:44:55   uplink to core     core-1
`;
    expect(readNeighbours(text)?.rows).toEqual([{ local: 'ge-0/0/1', name: 'core-1', port: 'uplink to core' }]);
  });

  it('reads Cisco past its capability legend and total line', () => {
    expect(readNeighbours(CISCO)).toEqual({ format: 'cisco', rows: [{ local: 'Gig0/0', name: 'R2', port: 'Gig0/0' }] });
  });

  it('reads Cisco with an empty Capability cell by column', () => {
    const text = `Device ID           Local Intf     Hold-time  Capability      Port ID
nas-1               Gi1/0/7        120                        eth0
`;
    expect(readNeighbours(text)?.rows).toEqual([{ local: 'Gi1/0/7', name: 'nas-1', port: 'eth0' }]);
  });

  it('reads Arista even with its header indented past its rows', () => {
    expect(readNeighbours(ARISTA)).toEqual({
      format: 'arista',
      rows: [
        { local: 'Et3/1', name: 'tg104.sjc.aristanetworks.com', port: 'Ethernet3/2' },
        { local: 'Ma1/1', name: 'dc1-rack11-tor1.sjc', port: '1/1' },
      ],
    });
  });

  it('reads lldpd blocks, and uses the description when the port is only a MAC', () => {
    expect(readNeighbours(LLDPD)).toEqual({ format: 'lldpd', rows: [{ local: 'eth0', name: 'PIONEERMS22', port: 'swp47' }] });
    const mac = LLDPD.replace('ifname swp47', 'mac 44:38:39:00:12:9b').replace('PortDescr:    swp47', 'PortDescr:    ge-0/0/3');
    expect(readNeighbours(mac)?.rows[0]?.port).toBe('ge-0/0/3');
  });

  it('is not fooled by a config or a sentence', () => {
    expect(looksLikeNeighbours('set system host-name sw1\nset interfaces ge-0/0/0 unit 0\n')).toBe(false);
    expect(looksLikeNeighbours('hello')).toBe(false);
    expect(looksLikeNeighbours(JUNOS)).toBe(true);
  });
});

interface Box {
  deviceId: string;
  chassisId: string;
  ports: Record<string, string>;
}

function addBox(doc: Document, hostname: string, labels: string[], connector = 'rj45'): { doc: Document; box: Box } {
  const had = new Set(doc.nodes.map((n) => n.id));
  let d = createSketchDevice(doc, { ...OPTS, hostname });
  const deviceId = d.nodes.find((n) => !had.has(n.id) && parseNodeId(n.id).kind === 'Device')!.id;
  const chassisId = d.nodes.find((n) => !had.has(n.id) && parseNodeId(n.id).kind === 'Chassis')!.id;
  const ports: Record<string, string> = {};
  for (const label of labels) {
    const before = new Set(d.nodes.map((n) => n.id));
    d = addSketchPort(d, chassisId, { label, connector, face: 'front' }, OPTS);
    ports[label] = d.nodes.find((n) => !before.has(n.id))!.id;
  }
  return { doc: d, box: { deviceId, chassisId, ports } };
}

/** The mockup's design: switch-1 with four ports, a router, two access points and a NAS. */
function mockDesign() {
  let doc = emptyDocument();
  const sw = addBox(doc, 'switch-1', ['ge-0/0/1', 'ge-0/0/4', 'ge-0/0/7', 'ge-0/0/9']);
  doc = sw.doc;
  const router = addBox(doc, 'router-1', ['ether2']);
  doc = router.doc;
  const lobby = addBox(doc, 'ap-lobby', ['eth0']);
  doc = lobby.doc;
  const nas = addBox(doc, 'nas-1', ['eth0']);
  doc = nas.doc;
  const office = addBox(doc, 'ap-office', ['1']);
  doc = office.doc;
  return { doc, sw: sw.box, router: router.box, lobby: lobby.box, nas: nas.box, office: office.box };
}

const MOCK = `Local Interface    Parent Interface    Chassis Id          Port info     System Name
ge-0/0/1           -                   00:00:5e:00:53:01   ether2        router-1
ge-0/0/4           -                   00:00:5e:00:53:02   eth0          ap-lobby.home.arpa
ge-0/0/7           -                   00:00:5e:00:53:03   eth0          nas-1
ge-0/0/9           -                   00:00:5e:00:53:04   eth0          ap-office
ge-0/0/12          -                   00:00:5e:00:53:05   eth0          printer
`;

describe('matching rows to the design', () => {
  it('finds a device by its whole name, or by the name before the dot, but never two', () => {
    const { doc, lobby } = mockDesign();
    expect(deviceNamed(doc, 'AP-LOBBY')).toBe(lobby.deviceId);
    expect(deviceNamed(doc, 'ap-lobby.home.arpa')).toBe(lobby.deviceId);
    expect(deviceNamed(doc, 'printer')).toBeNull();
    const twice = addBox(doc, 'ap-lobby.other.net', []).doc;
    expect(deviceNamed(twice, 'ap-lobby.home.arpa')).toBeNull();
  });

  it('finds a port by label, by a short spelling, or by a tied interface', () => {
    let { doc, box } = addBox(emptyDocument(), 'core', ['GigabitEthernet1/0/1', 'GigabitEthernet1/0/11', 'Ethernet3/2', '7']);
    expect(portNamed(doc, box.deviceId, 'Gi1/0/1')).toBe(box.ports['GigabitEthernet1/0/1']);
    expect(portNamed(doc, box.deviceId, 'Gig1/0/11')).toBe(box.ports['GigabitEthernet1/0/11']);
    expect(portNamed(doc, box.deviceId, 'Et3/2')).toBe(box.ports['Ethernet3/2']);
    expect(portNamed(doc, box.deviceId, 'G1/0/1')).toBeNull();
    expect(portNamed(doc, box.deviceId, 'Te1/0/1')).toBeNull();
    // A pasted interface tied to port 7 answers to its own name.
    const b = begin(doc, OPTS);
    const iface = addNode(b, 'Interface', { 'Interface.name': interfaceName('ge-0/0/6'), 'Interface.form': token('ethernet') });
    addEdge(b, 'HasInterface', box.deviceId, iface);
    addEdge(b, 'Occupies', iface, box.ports['7']!);
    doc = finish(b, 'tie');
    expect(portNamed(doc, box.deviceId, 'ge-0/0/6.0')).toBe(box.ports['7']);
  });

  it('suggests the mockup: three ready, one left for you, one not in the design', () => {
    const { doc, sw, router, lobby, nas } = mockDesign();
    const s = suggestCables(doc, sw.chassisId, readNeighbours(MOCK)!);
    expect(s.map((x) => x.state)).toEqual(['ready', 'ready', 'ready', 'no-port', 'no-device']);
    expect(s[0]).toMatchObject({ localPortId: sw.ports['ge-0/0/1'], remotePortId: router.ports['ether2'], remoteName: 'router-1' });
    expect(s[1]).toMatchObject({ remotePortId: lobby.ports['eth0'], remoteName: 'ap-lobby' });
    expect(s[2]).toMatchObject({ remotePortId: nas.ports['eth0'] });
    expect(s[3]!.why).toBe('ap-office has no port called eth0 drawn, so it is left for you.');
    expect(s[4]!.why).toBe('printer is not in this design yet, so its cable is left for you.');
  });

  it('never suggests over a cable: already there, or on a port that has another', () => {
    const m = mockDesign();
    let doc = connectPorts(m.doc, m.sw.ports['ge-0/0/1']!, m.router.ports['ether2']!, {}, OPTS);
    doc = connectPorts(doc, m.sw.ports['ge-0/0/4']!, m.nas.ports['eth0']!, {}, OPTS);
    const s = suggestCables(doc, m.sw.deviceId, readNeighbours(MOCK)!);
    expect(s[0]!.state).toBe('cabled');
    expect(s[1]!.state).toBe('busy');
    expect(s[2]!.state).toBe('busy');
    expect(s[2]!.why).toBe('nas-1 eth0 already has a cable, so it is left for you.');
  });

  it('leaves a port with two neighbours alone', () => {
    const m = mockDesign();
    const text = `${MOCK}ge-0/0/7           -                   00:00:5e:00:53:06   eth0          ap-lobby\n`;
    const s = suggestCables(m.doc, m.sw.deviceId, readNeighbours(text)!);
    expect(s[2]!.state).toBe('several');
    expect(s[5]!.state).toBe('several');
    expect(s[1]!.state).toBe('several');
  });

  it('refuses plugs that do not fit, and ignores a row naming the switch itself', () => {
    let doc = emptyDocument();
    const sw = addBox(doc, 'sw', ['xe-0/0/0'], 'sfp_plus');
    doc = sw.doc;
    const nas = addBox(doc, 'nas', ['eth0']);
    doc = nas.doc;
    const text = `Local Interface    Chassis Id   Port info   System Name
xe-0/0/0           aa           eth0        nas
xe-0/0/0           bb           xe-0/0/0    sw
`;
    const s = suggestCables(doc, sw.box.deviceId, readNeighbours(text)!);
    expect(s[0]!.state).toBe('clash');
    expect(s[0]!.why).toBe('sw xe-0/0/0 and nas eth0 take different plugs, so it is left for you.');
    expect(s).toHaveLength(1);
  });
});

describe('accepting', () => {
  it('adds only the ticked ready cables, as one undo step', () => {
    const m = mockDesign();
    const list = readNeighbours(MOCK)!;
    const s = suggestCables(m.doc, m.sw.deviceId, list);
    const keys = new Set([s[0]!.key, s[2]!.key, s[3]!.key]);
    const next = acceptSuggestions(m.doc, m.sw.deviceId, list, keys, OPTS);
    expect(next.batches.length).toBe(m.doc.batches.length + 1);
    expect(next.batches.at(-1)!.label).toBe('cables from neighbours');
    expect(edgesIn(next, m.router.ports['ether2']!, 'Terminates')).toHaveLength(1);
    expect(edgesIn(next, m.nas.ports['eth0']!, 'Terminates')).toHaveLength(1);
    expect(edgesIn(next, m.lobby.ports['eth0']!, 'Terminates')).toHaveLength(0);
    const back = undo(next, next.batches.at(-1)!.id, { actor: 'test', now: NOW + 1 });
    expect(edgesIn(back, m.router.ports['ether2']!, 'Terminates')).toHaveLength(0);
  });

  it('skips a port cabled after the list was read', () => {
    const m = mockDesign();
    const list = readNeighbours(MOCK)!;
    const s = suggestCables(m.doc, m.sw.deviceId, list);
    const moved = connectPorts(m.doc, m.sw.ports['ge-0/0/1']!, m.lobby.ports['eth0']!, {}, OPTS);
    const next = acceptSuggestions(moved, m.sw.deviceId, list, new Set(s.map((x) => x.key)), OPTS);
    expect(edgesIn(next, m.router.ports['ether2']!, 'Terminates')).toHaveLength(0);
    expect(edgesIn(next, m.nas.ports['eth0']!, 'Terminates')).toHaveLength(1);
  });
});
