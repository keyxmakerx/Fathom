// A small estate for the troubleshooting tests: nas-01 on PDU-A outlet 4, cable 0412 (red) to sw-02 port 23, pc-04
// beside it, fw-01 as VLAN 20's gateway. Built with the real document commands.
import { connectPorts, setCableField } from '../../document/cables';
import { addSketchPort, createSketchDevice } from '../../document/commands';
import { addSubnet, addVlan } from '../../document/networks';
import { edgesOut, emptyDocument, type Document } from '../../document/model';

export const tick = (() => {
  let now = 1_790_900_000_000;
  return () => ({ actor: '01ARZ3NDEKTSV4RRFFQ69G5FAV', now: (now += 1000) });
})();

export interface Box {
  device: string;
  chassis: string;
  port(label: string): string;
}

export function addBox(doc: Document, hostname: string, ports: { label: string; connector: string; service?: string }[]): { doc: Document; box: Box } {
  const before = new Set(doc.nodes.map((n) => n.id));
  let next = createSketchDevice(doc, { hostname, ...tick() });
  const fresh = next.nodes.filter((n) => !before.has(n.id));
  const device = fresh.find((n) => n.id.startsWith('device:'))!.id;
  const chassis = fresh.find((n) => n.id.startsWith('chassis:'))!.id;
  const ids = new Map<string, string>();
  for (const p of ports) {
    const known = new Set(edgesOut(next, chassis, 'HasPort').map((e) => e.to));
    next = addSketchPort(next, chassis, { label: p.label, connector: p.connector, service: p.service ?? (p.connector === 'rj45' ? 'ethernet' : 'power'), face: 'front' }, tick());
    ids.set(p.label, edgesOut(next, chassis, 'HasPort').find((e) => !known.has(e.to))!.to);
  }
  return { doc: next, box: { device, chassis, port: (l) => ids.get(l)! } };
}

export const eth = (n: number): { label: string; connector: string }[] => Array.from({ length: n }, (_, i) => ({ label: String(i + 1), connector: 'rj45' }));

export interface Lab {
  doc: Document;
  pdu: Box;
  nas: Box;
  sw: Box;
  pc: Box;
  fw: Box;
  cable: string;
}

/** nas-01 on PDU-A outlet 4, cable 0412 (red) to sw-02 port 23; pc-04 on sw-02; fw-01 is the VLAN 20 gateway. */
export function lab(opts: { power?: boolean; uplink?: boolean; network?: boolean } = {}): Lab {
  const { power = true, uplink = true, network = true } = opts;
  let doc = emptyDocument();
  const mk = (name: string, ports: { label: string; connector: string; service?: string }[]): Box => {
    const made = addBox(doc, name, ports);
    doc = made.doc;
    return made.box;
  };
  const pdu = mk('PDU-A', ['1', '2', '3', '4'].map((label) => ({ label, connector: 'c13', service: 'power' })));
  const nas = mk('nas-01', [{ label: 'eth0', connector: 'rj45' }, { label: 'PSU', connector: 'c14', service: 'power' }]);
  const sw = mk('sw-02', eth(24));
  const pc = mk('pc-04', [{ label: 'eth0', connector: 'rj45' }]);
  const fw = mk('fw-01', eth(4));
  if (power) doc = connectPorts(doc, pdu.port('4'), nas.port('PSU'), {}, tick());
  let cable = '';
  if (uplink) {
    doc = connectPorts(doc, nas.port('eth0'), sw.port('23'), { sheath: 'red' }, tick());
    cable = doc.nodes.filter((n) => n.id.startsWith('cable:')).at(-1)!.id;
    doc = setCableField(doc, cable, 'label', '0412', tick());
  }
  doc = connectPorts(doc, pc.port('eth0'), sw.port('5'), {}, tick());
  doc = connectPorts(doc, sw.port('1'), fw.port('1'), {}, tick());
  if (network) {
    doc = addVlan(
      doc,
      {
        vlanId: 20,
        name: 'Servers',
        attach: [{ target: { kind: 'port', portId: sw.port('23'), interfaceName: 'ge-0/0/23' } }, { target: { kind: 'port', portId: fw.port('2'), interfaceName: 'ge-0/0/2' }, gateway: true }],
        subnet: '10.0.20.0/24',
        gatewayAddress: '10.0.20.1/24',
      },
      tick(),
    );
    doc = addSubnet(doc, { prefix: '10.0.20.0/24', attach: [{ target: { kind: 'port', portId: nas.port('eth0'), interfaceName: 'eth0' }, address: '10.0.20.15/24' }] }, tick());
  }
  return { doc, pdu, nas, sw, pc, fw, cable };
}
