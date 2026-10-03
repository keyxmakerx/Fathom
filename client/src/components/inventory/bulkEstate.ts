// A large made-up estate for the scale proof and the review drive: built by writing nodes and edges
// straight into arrays (the editor's commands copy the document on every write, which is far too
// slow for twenty thousand things). Same node and edge shapes the commands write; a test checks a
// small one against `viewOf`. Test and drive support only: nothing in the app imports this.
//
// The closet model has one Premises, so the estate is one premises whose racks stand in rows named
// for their site ("LON1 Row A"): that is how Where's middle level reads today.

import { emptyDocument, formatEdgeId, formatNodeId, identifier, text, token, uint, type Document, type EdgeKind, type FieldEntry, type GraphEdge, type GraphNode, type NodeKind, type Op, type ProvenanceRecord, compareEdgeId, compareNodeId } from '../../document/model';
import type { CanonValue } from '../../document/canon';
import { newUlid } from '../../document/ulid';

export interface BulkOptions {
  /** 1 is the full estate (~2,000 devices, ~12,000 ports, ~5,000 cables); smaller scales it down. */
  scale?: number;
  seed?: number;
  actor?: string;
  now?: number;
}

export interface BulkStats {
  devices: number;
  ports: number;
  cables: number;
  racks: number;
}

export interface BulkEstate {
  doc: Document;
  stats: BulkStats;
  /** Things the drive and tests look for by name. */
  known: {
    premises: string;
    torDevice: string;
    torPort: string;
    /** A cable label that runs through two patch panels. */
    trunkLabel: string;
    /** A cable on the trunk with no label. */
    unlabelledRack: string;
    serial: string;
    serialDevice: string;
    longLabel: string;
  };
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Builder {
  nodes: GraphNode[] = [];
  edges: GraphEdge[] = [];
  provenance: ProvenanceRecord[] = [];
  ops: Op[] = [];
  readonly now: number;
  readonly actor: string;
  constructor(now: number, actor: string) {
    this.now = now;
    this.actor = actor;
  }

  private hand(): string {
    const id = newUlid(this.now);
    this.provenance.push({ id, origin: { kind: 'hand' }, assertedAt: this.now, assertedBy: this.actor, confidence: 'asserted' });
    return id;
  }

  private fields(element: string, values: Record<string, CanonValue>): Record<string, FieldEntry> {
    const out: Record<string, FieldEntry> = {};
    for (const [key, value] of Object.entries(values)) {
      const prov = this.hand();
      out[key] = { presence: 'set', prov, value };
      this.ops.push({ type: 'set_field', element, key, presence: 'set', prov });
    }
    return out;
  }

  node(kind: NodeKind, values: Record<string, CanonValue>): string {
    const id = formatNodeId(kind, newUlid(this.now));
    const existence = this.hand();
    this.ops.push({ type: 'add_node', node: id, prov: existence });
    this.nodes.push({ id, existence, fields: this.fields(id, values) });
    return id;
  }

  edge(kind: EdgeKind, from: string, to: string, values: Record<string, CanonValue> = {}): string {
    const id = formatEdgeId(kind, newUlid(this.now));
    const prov = this.hand();
    this.ops.push({ type: 'add_edge', edge: id, from, to, prov });
    this.edges.push({ id, from, to, prov, fields: this.fields(id, values) });
    return id;
  }

  finish(): Document {
    const nodes = [...this.nodes].sort((a, b) => compareNodeId(a.id, b.id));
    const edges = [...this.edges].sort((a, b) => compareEdgeId(a.id, b.id));
    const provenance = [...this.provenance].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { ...emptyDocument(), nodes, edges, provenance, batches: [{ id: newUlid(this.now), label: 'seed estate', ops: this.ops }] };
  }
}

const SERIAL_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';

interface SiteSpec {
  code: string;
  /** Racks per row. */
  rows: number[];
  kind: 'dc' | 'office';
  desks?: number;
  aps?: number;
  cams?: number;
}

const SITES: readonly SiteSpec[] = [
  { code: 'LON1', kind: 'dc', rows: [34, 34] },
  { code: 'LON2', kind: 'dc', rows: [26, 26] },
  { code: 'MAN1', kind: 'office', rows: [3], desks: 160, aps: 36, cams: 20 },
  { code: 'BRS1', kind: 'office', rows: [2], desks: 100, aps: 16, cams: 10 },
  { code: 'EDI1', kind: 'office', rows: [2], desks: 70, aps: 12, cams: 8 },
];

const pad = (n: number, w: number): string => String(n).padStart(w, '0');

export function bulkEstate(opts: BulkOptions = {}): BulkEstate {
  const scale = opts.scale ?? 1;
  const rnd = rng(opts.seed ?? 20261003);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const int = (a: number, b: number): number => a + Math.floor(rnd() * (b - a + 1));
  const b = new Builder(opts.now ?? 1_790_000_000_000, opts.actor ?? '00000000000000000000000000');
  const serial = (prefix: string): string => prefix + Array.from({ length: 8 }, () => SERIAL_CHARS[int(0, SERIAL_CHARS.length - 1)]).join('');
  const stats: BulkStats = { devices: 0, ports: 0, cables: 0, racks: 0 };
  let labelN = 10001;

  const premises = b.node('Premises', { 'Premises.label': text('Northwind') });

  interface Port {
    id: string;
    label: string;
  }
  interface Host {
    chassis: string;
    name: string;
    ports: Port[];
    front: Port[];
    rear: Port[];
  }

  const device = (name: string, role: string | null, ser: string | null): { deviceId: string; chassis: string } => {
    const deviceId = b.node('Device', { 'Device.hostname': identifier(name), ...(role ? { 'Device.role': token(role) } : {}) });
    const chassis = b.node('Chassis', ser ? { 'Chassis.serial': identifier(ser) } : {});
    b.edge('HasChassis', deviceId, chassis);
    stats.devices += 1;
    return { deviceId, chassis };
  };
  const port = (chassis: string, label: string, connector: string, face: 'front' | 'rear', service?: string): Port => {
    const id = b.node('PhysicalPort', { 'PhysicalPort.label': text(label), 'PhysicalPort.connector': token(connector), 'PhysicalPort.face': token(face), ...(service ? { 'PhysicalPort.service': token(service) } : {}) });
    b.edge('HasPort', chassis, id);
    stats.ports += 1;
    return { id, label };
  };
  const mount = (chassis: string, rack: string, u: number, h = 1) => b.edge('MountedIn', chassis, rack, { 'MountedIn.position_u': uint(u, 16), 'MountedIn.height_u': uint(h, 8), 'MountedIn.face': token('front') });

  const racked = (name: string, role: string | null, rack: string, u: number, h: number, ser: string | null, labels: Array<[string, string, string?]>): Host => {
    const { chassis } = device(name, role, ser);
    mount(chassis, rack, u, h);
    const ports = labels.map(([l, c, svc]) => port(chassis, l, c, 'front', svc));
    return { chassis, name, ports, front: ports, rear: [] };
  };
  const panel = (name: string, rack: string, u: number, n: number, connector: string): Host => {
    const { chassis } = device(name, null, null);
    mount(chassis, rack, u);
    const front: Port[] = [];
    const rear: Port[] = [];
    for (let i = 1; i <= n; i += 1) {
      const f = port(chassis, String(i), connector, 'front');
      const r = port(chassis, String(i), connector, 'rear');
      b.edge('PassThrough', f.id, r.id);
      front.push(f);
      rear.push(r);
    }
    return { chassis, name, ports: [...front, ...rear], front, rear };
  };

  const cableLabel = (): string => `C-${labelN++}`;
  const known: BulkEstate['known'] = { premises: 'Northwind', torDevice: '', torPort: '', trunkLabel: '', unlabelledRack: '', serial: '', serialDevice: '', longLabel: '' };
  const cable = (a: Port, z: Port, media: string, lengthM: number, sheath: string, labelled = true): string => {
    const label = labelled && rnd() > 0.035 ? cableLabel() : null;
    if (!label) labelN += 1;
    const id = b.node('Cable', { 'Cable.media': token(media), ...(label ? { 'Cable.label': text(label) } : {}), 'Cable.length_m': uint(lengthM, 32), 'Cable.sheath': token(sheath) });
    b.edge('Terminates', id, a.id, { 'Terminates.end': token('a') });
    b.edge('Terminates', id, z.id, { 'Terminates.end': token('b') });
    stats.cables += 1;
    return label ?? '';
  };

  const gige = (prefix: string, n: number): Array<[string, string, string?]> => Array.from({ length: n }, (_, i) => [`${prefix}${i}`, 'rj45']);

  for (const site of SITES) {
    const rowLetters = 'ABCDEFGH';
    const rackOf: Array<{ id: string; label: string; row: string }> = [];
    site.rows.forEach((count, ri) => {
      const row = `${site.code} Row ${rowLetters[ri]}`;
      const n = Math.max(1, Math.round(count * scale));
      for (let i = 1; i <= n; i += 1) {
        const label = `${site.code}-${rowLetters[ri]}${pad(i, 2)}`;
        const id = b.node('Rack', { 'Rack.label': text(label), 'Rack.height_u': uint(site.kind === 'dc' ? 47 : 42, 8), 'Rack.unit_numbering': token('ascending'), 'Rack.row': text(row) });
        b.edge('HasRack', premises, id);
        stats.racks += 1;
        rackOf.push({ id, label, row });
      }
    });
    const lc = site.code.toLowerCase();

    if (site.kind === 'dc') {
      const core = rackOf[0]!;
      const cores = [1, 2].map((k) => racked(`${lc}-core${k}`, 'switch', core.id, 44 - k, 1, serial('WS'), Array.from({ length: 48 }, (_, i): [string, string] => [`xe-0/0/${i}`, 'lc'])));
      [1, 2].forEach((k) => {
        const fw = racked(`${lc}-fw${k}`, 'firewall', core.id, 38 - k * 2, 2, serial('CW'), Array.from({ length: 8 }, (_, i): [string, string] => [`xe-1/0/${i}`, 'lc']));
        cable(fw.ports[0]!, cores[k - 1]!.ports[46]!, 'twinax', 1, 'black');
      });
      const edgeRacks = rackOf.slice(1);
      const coreRacks = Math.max(1, Math.ceil((edgeRacks.length * 2) / 24));
      const corePanels = Array.from({ length: coreRacks }, (_, k) => panel(`${lc}-${core.label.toLowerCase().slice(-3)}-cpp${k + 1}`, core.id, 47 - k, 24, 'lc'));
      let trunk = 0;
      let srv = 1;
      edgeRacks.forEach((r, ri) => {
        const rl = r.label.toLowerCase();
        const pp = panel(`${rl}-pp1`, r.id, 47, 6, 'lc');
        const tor = racked(`${rl}-tor1`, 'switch', r.id, 46, 1, serial('XH'), [...gige('ge-0/0/', 36), ['xe-0/2/0', 'sfp_plus'], ['xe-0/2/1', 'sfp_plus']]);
        if (!known.torDevice) {
          known.torDevice = tor.name;
          known.torPort = 'ge-0/0/4';
        }
        [0, 1].forEach((u) => {
          const cp = corePanels[Math.floor(trunk / 24)]!;
          const cpPort = trunk % 24;
          trunk += 1;
          cable(tor.ports[36 + u]!, pp.front[u]!, 'mmf', 2, 'aqua');
          const lab = cable(pp.rear[u]!, cp.rear[cpPort]!, 'mmf', int(18, 64), 'aqua');
          if (!known.trunkLabel && lab) known.trunkLabel = lab;
          cable(cp.front[cpPort]!, cores[u]!.ports[ri % 40]!, 'mmf', 2, 'aqua');
        });
        const servers = int(8, 12);
        let u = 42;
        for (let s = 0; s < servers && u > 4; s += 1) {
          const h = rnd() < 0.3 ? 2 : 1;
          const storage = rnd() < 0.12;
          const name = `${lc}-${storage ? 'nas' : 'srv'}${pad(srv, 4)}`;
          srv += 1;
          const ser = serial(pick(['8T', 'CZ', 'J9']));
          const host = racked(name, 'server', r.id, u - h + 1, h, ser, [['eno1', 'rj45'], ['eno2', 'rj45'], ['eno3', 'rj45'], ['idrac', 'rj45', 'management']]);
          if (!known.serial) {
            known.serial = ser;
            known.serialDevice = name;
          }
          u -= h + (rnd() < 0.25 ? int(1, 3) : 0);
          cable(host.ports[0]!, tor.ports[s * 2]!, 'cat6', pick([1, 2, 3]), 'blue');
          if (rnd() < 0.85) cable(host.ports[1]!, tor.ports[s * 2 + 1]!, 'cat6', pick([1, 2, 3]), 'blue');
          cable(host.ports[3]!, tor.ports[30 + (s % 6)]!, 'cat6', pick([1, 2]), 'yellow');
        }
        if (!known.unlabelledRack && rnd() < 0.2) known.unlabelledRack = r.label;
      });
    } else {
      const surface = b.node('Surface', { 'Surface.label': text(`${site.code} floor`), 'Surface.form': token('floor') });
      b.edge('HasSurface', premises, surface);
      const comms = rackOf[0]!;
      const fw = racked(`${lc}-fw1`, 'firewall', comms.id, 40, 1, serial('CW'), Array.from({ length: 16 }, (_, i): [string, string] => [`ge-0/0/${i}`, 'rj45']));
      const endpoints: Array<{ role: string; prefix: string; n: number }> = [
        { role: 'access_point', prefix: 'ap', n: Math.round((site.aps ?? 0) * scale) },
        { role: 'other', prefix: 'cam', n: Math.round((site.cams ?? 0) * scale) },
        { role: 'other', prefix: 'pc', n: Math.round((site.desks ?? 0) * scale) },
      ];
      const total = endpoints.reduce((n, e) => n + e.n, 0);
      const panels: Host[] = [];
      const switches: Host[] = [];
      const needed = Math.max(1, Math.ceil(total / 24));
      for (let k = 0; k < needed; k += 1) {
        const r = rackOf[k % rackOf.length]!;
        panels.push(panel(`${lc}-${pad(k + 1, 2)}-pp`, r.id, 38 - 3 * Math.floor(k / rackOf.length), 24, 'rj45'));
        switches.push(racked(`${lc}-sw${pad(k + 1, 2)}`, 'switch', r.id, 37 - 3 * Math.floor(k / rackOf.length), 1, serial('FOC'), [...gige('Gi1/0/', 24).map(([l, c]): [string, string] => [l, c]), ['Te1/1/1', 'sfp_plus']]));
        cable(switches[k]!.ports[24]!, fw.ports[2 + (k % 12)]!, 'mmf', 3, 'aqua');
      }
      let i = 0;
      for (const e of endpoints) {
        for (let k = 1; k <= e.n; k += 1) {
          const { chassis } = device(`${lc}-${e.prefix}${pad(k, 3)}`, e.role, serial(pick(['5H', 'F4', 'B8', 'E7'])));
          b.edge('FixedTo', chassis, surface, { 'FixedTo.x_mm': uint(100 + (i % 40) * 150, 32), 'FixedTo.y_mm': uint(100 + Math.floor(i / 40) * 150, 32) });
          const eth = port(chassis, 'eth0', 'rj45', 'front');
          const p = panels[Math.floor(i / 24)]!;
          const slot = i % 24;
          cable(p.rear[slot]!, eth, 'cat6a', int(8, 85), 'white');
          if (rnd() < 0.92) cable(switches[Math.floor(i / 24)]!.ports[slot]!, p.front[slot]!, 'cat6a', pick([1, 2]), pick(['blue', 'purple']));
          i += 1;
        }
      }
    }
  }
  return { doc: b.finish(), stats, known };
}
