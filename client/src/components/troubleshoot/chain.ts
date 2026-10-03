// The chain an "It's down" session walks (ADR-0061 troubleshooting): for one device, the things it depends on, nearest
// first, as questions. Pure: read off the Document, nothing stored. Only what the graph holds is used; where a link
// is missing the step says Fathom does not know, and is still answerable. Fathom never names a cause: a step
// carries the parts that would be suspect if it fails and the tests that would tell them apart (pointing.ts).
import { deriveNetworks } from '../../document/networks-derive';
import {
  asString,
  edgesIn,
  edgesOut,
  fieldValue,
  findNode,
  parseNodeId,
  readPhysicalPortFields,
  type Document,
  type GraphNode,
} from '../../document/model';
import type { StepTopic } from '../../document/issues';
import { buildCanon, type Canon } from '../checks/checksModel';
import { nameOf } from '../plans/plansModel';

/** A part that would be suspect if its step fails: what to call it, and the element a fix would name. */
export interface Suspect {
  label: string;
  id: string;
}

export interface ChainStep {
  topic: StepTopic;
  question: string;
  detail: string;
  /** Design ids to light on the canvas (ports, cables, devices), as plan steps hold them. */
  targets: string[];
  /** The Why? card: short paragraphs, from the Checks rules where one matches, else fixed sentences. */
  why: string[];
  /** Whether the graph holds what this step is about. A step the graph cannot fill still asks. */
  known: boolean;
  suspects: Suspect[];
  tests: string[];
}

export interface Chain {
  deviceId: string;
  deviceName: string;
  steps: ChainStep[];
}

// ---------------------------------------------------------------------------
// Why? text. The rule texts are the corpus's own `why`, word for word (a test reads corpus/rules/* and compares);
// the lead sentences are fixed.

export const WHY_RULES: Readonly<Record<string, string>> = {
  'power.psu.single-fed': 'Two power inlets protect the device only when both are connected. With one cabled, the device still stops when that feed fails.',
  'phy.link.speed-mismatch': 'When both ends of a link have a fixed speed and the speeds differ, the link will usually not come up. Auto-negotiation only works when both ends negotiate.',
  'phy.port.already-cabled': 'A port takes one cable. Two cables on the same port cannot both carry its traffic. Only a breakout port, where each cable is a numbered lane, takes several.',
  'l2.vlan.access-mismatch': "A cable between two access ports joins their VLANs into one broadcast domain. Hosts in each VLAN see the other's traffic, and the VLAN numbers no longer mean the same thing at both ends.",
  'l2.vlan.trunk-missing': 'A trunk carries only the VLANs listed on both ends. A VLAN listed on one end and missing from the other is cut at the far side: its hosts cannot reach across this link.',
  'ip.address.same-on-link': 'Both ends of one cable hold the same address, so neither can reach the other: each treats the address as its own.',
  'ip.address.different-subnet-on-link':
    "The two ends of one cable do not agree on the link's subnet. Each end may send the other's traffic to a gateway, and protocols that need a shared subnet, such as OSPF adjacency, will not form.",
  'topo.switch.single-cable': 'Only one cable is recorded on this switch, power cords included. If it is the only link out and it fails, the switch is cut off.',
};

const FIXED = {
  power: 'A device with no power shows no lights and answers nothing, so power comes first.',
  neighbours: 'If the other devices on the same switch work, the switch is fine and the answers point nearer this device. If they are down too, they point at the switch or what feeds it.',
  link: 'A link light means both ends see a signal. No light usually points at the cable or the port at either end, or at two ends that cannot agree on a speed.',
  port: 'A port can be switched off, or sit in a different VLAN from the device on the other end. The link light can be on and nothing get through.',
  address: 'A device that is up can still fail to answer if its address is wrong, held twice, or on a different subnet from the device asking.',
  gateway: 'The gateway is the way off the local network. A device can answer on its own network and still be unreachable from elsewhere when its gateway is down.',
} as const;

// ---------------------------------------------------------------------------
// Reading the graph

const live = (doc: Document, id: string): GraphNode | undefined => {
  const n = findNode(doc, id);
  return n && n.absentSince === undefined ? n : undefined;
};

const kindOf = (id: string): string => {
  try {
    return parseNodeId(id).kind;
  } catch {
    return '';
  }
};

const field = (n: GraphNode | undefined, key: string): string => (n ? (asString(fieldValue(n.fields, key)) ?? '') : '');

/** The chassis of a device. */
function chassisOf(doc: Document, deviceId: string): string[] {
  return edgesOut(doc, deviceId, 'HasChassis')
    .map((e) => e.to)
    .filter((id) => live(doc, id) !== undefined);
}

/** Every port on a device: its chassis' own, and those on supplies fitted in it. */
function portsOfDevice(doc: Document, deviceId: string): string[] {
  const out: string[] = [];
  for (const chassis of chassisOf(doc, deviceId)) {
    for (const e of edgesOut(doc, chassis, 'HasPort')) out.push(e.to);
    for (const fit of edgesOut(doc, chassis, 'FittedIn')) {
      for (const e of edgesOut(doc, fit.to, 'HasPort')) out.push(e.to);
    }
  }
  return out.filter((id) => live(doc, id) !== undefined);
}

const isPower = (doc: Document, portId: string): boolean => {
  const f = readPhysicalPortFields(live(doc, portId) ?? ({ id: portId, fields: {} } as GraphNode));
  return f.service === 'power' || f.connector === 'c13' || f.connector === 'c14';
};

const naturalCompare = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

const portLabel = (doc: Document, portId: string): string => field(live(doc, portId), 'PhysicalPort.label');

/** "port 23" for a numbered port, the label itself ("eth0") for a named one. */
export function portWord(label: string): string {
  if (label === '') return 'a port';
  return /^\d+$/.test(label) ? `port ${label}` : label;
}

/** "outlet 4" for a numbered outlet; a named one as it is. */
function outletWord(label: string): string {
  if (label === '') return 'an outlet';
  return /^\d+$/.test(label) ? `outlet ${label}` : label;
}

function cablesAt(doc: Document, portId: string): string[] {
  return edgesIn(doc, portId, 'Terminates')
    .map((e) => e.from)
    .filter((id) => live(doc, id) !== undefined);
}

/** The ends of a cable that are not `near`. */
function otherEnds(doc: Document, cableId: string, near: string): string[] {
  return edgesOut(doc, cableId, 'Terminates')
    .map((e) => e.to)
    .filter((id) => id !== near);
}

interface Owner {
  /** The device, passive or outside peer a port belongs to; '' when the graph does not say. */
  id: string;
  kind: 'device' | 'passive' | 'external' | 'unknown';
}

function ownerOf(doc: Document, portId: string): Owner {
  if (kindOf(portId) === 'ExternalPeer') return { id: portId, kind: 'external' };
  let at = portId;
  for (let i = 0; i < 6; i += 1) {
    const k = kindOf(at);
    if (k === 'Device') return { id: at, kind: 'device' };
    if (k === 'PassiveNode') return { id: at, kind: 'passive' };
    const up = edgesIn(doc, at, 'HasPort')[0] ?? edgesIn(doc, at, 'FittedIn')[0] ?? edgesIn(doc, at, 'HasChassis')[0];
    if (!up) return { id: '', kind: 'unknown' };
    at = up.from;
  }
  return { id: '', kind: 'unknown' };
}

/** The far end of a cable from `near`, followed through patch panels: the device or outside peer reached, the port
 * there, and every cable and passive part on the way (all lit with the step). */
interface Far {
  port: string;
  owner: Owner;
  via: string[];
}

function followCable(doc: Document, near: string, cable: string): Far | null {
  const via = [cable];
  let from = near;
  let current = cable;
  for (let hop = 0; hop < 8; hop += 1) {
    const end = otherEnds(doc, current, from)[0];
    if (end === undefined) return null;
    const owner = ownerOf(doc, end);
    if (owner.kind !== 'passive') return { port: end, owner, via };
    // A patch panel: the same hole on its other face, then that hole's cable.
    via.push(owner.id, end);
    const pair = [...edgesOut(doc, end, 'PassThrough'), ...edgesIn(doc, end, 'PassThrough')].map((e) => (e.from === end ? e.to : e.from))[0];
    if (pair === undefined) return { port: end, owner, via };
    via.push(pair);
    const next = cablesAt(doc, pair).find((c) => c !== current);
    if (next === undefined) return { port: pair, owner, via };
    from = pair;
    current = next;
    via.push(next);
  }
  return null;
}

const unique = (ids: readonly string[]): string[] => [...new Set(ids.filter((i) => i !== ''))];

// ---------------------------------------------------------------------------
// Names

interface Names {
  doc: Document;
  canon: Canon;
  name(id: string): string;
}

function cableWord(doc: Document, cableId: string): string {
  const n = live(doc, cableId);
  const label = field(n, 'Cable.label');
  const sheath = field(n, 'Cable.sheath');
  return `${label !== '' ? `Cable ${label}` : 'Cable'}${sheath !== '' ? `, ${sheath}` : ''}`;
}

function listNames(names: readonly string[], max = 3): string {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

/** "a or b", "a, b or c". */
export function orList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
}

// ---------------------------------------------------------------------------
// The steps

function powerStep(n: Names, deviceId: string, dev: string): ChainStep {
  const { doc } = n;
  const inlets = portsOfDevice(doc, deviceId).filter((p) => isPower(doc, p));
  const feeds: { inlet: string; cable: string; far: Far }[] = [];
  for (const inlet of inlets) {
    const cable = cablesAt(doc, inlet)[0];
    const far = cable === undefined ? null : followCable(doc, inlet, cable);
    if (cable !== undefined && far !== null) feeds.push({ inlet, cable, far });
  }
  const why: string[] = [FIXED.power];
  if (feeds.length === 0) {
    return {
      topic: 'power',
      question: `Is ${dev} getting power?`,
      detail: `Fathom doesn't know what powers ${dev}. ${inlets.length === 0 ? `Is it plugged in and switched on?` : `It has a power inlet with no cable recorded. Is it plugged in and switched on?`}`,
      targets: unique([deviceId, ...inlets]),
      why,
      known: false,
      suspects: [{ label: `what powers ${dev}`, id: deviceId }],
      tests: [`Plug something else into the same outlet, or ${dev} into another one`],
    };
  }
  const feedName = (f: (typeof feeds)[number]): string => {
    const owner = f.far.owner;
    const outlet = outletWord(portLabel(doc, f.far.port));
    return owner.kind === 'device' ? `${n.name(owner.id)} ${outlet}` : owner.kind === 'passive' ? n.name(owner.id) : outlet;
  };
  const names = feeds.map(feedName);
  if (inlets.length >= 2 && feeds.length === 1) why.push(WHY_RULES['power.psu.single-fed']);
  const first = feeds[0];
  return {
    topic: 'power',
    question: `Is ${dev} getting power from ${names.join(' and ')}?`,
    detail:
      inlets.length >= 2 && feeds.length === 1
        ? `${cableWord(doc, first.cable)}, to ${dev} ${portWord(portLabel(doc, first.inlet))}. The second inlet has no cable recorded.`
        : `${feeds.map((f) => `${cableWord(doc, f.cable)}, to ${dev} ${portWord(portLabel(doc, f.inlet))}`).join('; ')}`,
    targets: unique([deviceId, ...feeds.flatMap((f) => [f.inlet, f.cable, f.far.port, f.far.owner.id, ...f.far.via])]),
    why,
    known: true,
    suspects: [
      ...feeds.map((f, i) => ({ label: names[i], id: f.far.port })),
      ...feeds.map((f) => ({ label: 'the power cable', id: f.cable })),
    ].filter((s, i, all) => all.findIndex((x) => x.id === s.id) === i),
    tests: [`Plug a lamp or another device into ${names[0]}`, `Try ${dev} on another outlet`],
  };
}

interface Uplink {
  /** The device's own port. */
  near: string;
  cable: string;
  far: Far;
}

/** The first cabled data port of the device, in label order. */
function uplinkOf(doc: Document, deviceId: string): Uplink | null {
  const ports = portsOfDevice(doc, deviceId)
    .filter((p) => !isPower(doc, p))
    .sort((a, b) => naturalCompare(portLabel(doc, a), portLabel(doc, b)));
  for (const near of ports) {
    const cable = cablesAt(doc, near)[0];
    if (cable === undefined) continue;
    const far = followCable(doc, near, cable);
    if (far !== null) return { near, cable, far };
  }
  return null;
}

/** Other devices cabled to `switchId` (data cables only), with the cable to each. */
function othersOn(doc: Document, switchId: string, except: string): { id: string; cable: string }[] {
  const out: { id: string; cable: string }[] = [];
  for (const port of portsOfDevice(doc, switchId)) {
    if (isPower(doc, port)) continue;
    for (const cable of cablesAt(doc, port)) {
      const far = followCable(doc, port, cable);
      if (far === null || far.owner.kind !== 'device' || far.owner.id === except || far.owner.id === switchId) continue;
      if (!out.some((o) => o.id === far.owner.id)) out.push({ id: far.owner.id, cable });
    }
  }
  return out.sort((a, b) => naturalCompare(nameOf(doc, (id) => id, a.id), nameOf(doc, (id) => id, b.id)));
}

function freePorts(doc: Document, deviceId: string, like: string): number {
  const connector = readPhysicalPortFields(live(doc, like) ?? ({ id: like, fields: {} } as GraphNode)).connector;
  return portsOfDevice(doc, deviceId).filter((p) => {
    if (isPower(doc, p) || cablesAt(doc, p).length > 0) return false;
    return connector === undefined || readPhysicalPortFields(live(doc, p)!).connector === connector;
  }).length;
}

function networkFacts(doc: Document, deviceId: string, cableId: string, switchId: string) {
  const d = deriveNetworks(doc);
  // The VLAN the switch's port carries: the row holding a member of that switch on this cable.
  const portRow = d.vlanRows.find((r) => r.members.some((m) => m.deviceId === switchId && m.cableId === cableId));
  const portMember = portRow?.members.find((m) => m.deviceId === switchId && m.cableId === cableId);
  const deviceRows = d.vlanRows.filter((r) => r.members.some((m) => m.deviceId === deviceId));
  // The device sits in the VLAN its switch port carries, or in one it is a member of itself. The gateway is the
  // member of a row with that VLAN id that holds the VLAN's L3 interface.
  const ids = new Set([...(portRow ? [portRow.vlanId] : []), ...deviceRows.map((r) => r.vlanId)]);
  const gateway = d.vlanRows
    .filter((r) => ids.has(r.vlanId))
    .flatMap((r) => r.members)
    .find((m) => m.isGateway && m.deviceId !== deviceId);
  const subnetAddress = d.subnetRows.flatMap((r) => r.members).find((m) => m.deviceId === deviceId)?.address;
  const vlanAddress = deviceRows.flatMap((r) => r.members).find((m) => m.deviceId === deviceId && m.address !== undefined)?.address;
  return { vlan: portRow?.vlanId, mode: portMember?.mode, gateway, address: subnetAddress ?? vlanAddress };
}

const bare = (address: string): string => address.split('/')[0];

/** The built chain for a device: the steps nearest first, ready to ask. */
export function buildChain(doc: Document, deviceId: string): Chain {
  const canon = buildCanon(doc);
  const n: Names = { doc, canon, name: (id) => nameOf(doc, canon, id) };
  const dev = n.name(deviceId);
  const steps: ChainStep[] = [powerStep(n, deviceId, dev)];

  const up = uplinkOf(doc, deviceId);
  const nearLabel = up ? portLabel(doc, up.near) : '';
  const nearWord = up ? `${dev} ${portWord(nearLabel)}` : dev;
  const farDevice = up && up.far.owner.kind === 'device' ? up.far.owner.id : '';
  const sw = farDevice !== '' ? n.name(farDevice) : up?.far.owner.kind === 'external' ? field(live(doc, up.far.owner.id), 'ExternalPeer.label') || 'the outside network' : '';
  const farLabel = up ? portLabel(doc, up.far.port) : '';
  const farWord = farLabel === '' ? 'a port' : portWord(farLabel);

  if (up === null) {
    steps.push({
      topic: 'link',
      question: `Is there a link light on ${dev}'s network port?`,
      detail: `Fathom doesn't know what ${dev} is cabled to. Is there a cable in its network port?`,
      targets: [deviceId],
      why: [FIXED.link],
      known: false,
      suspects: [{ label: `the cable or port on ${dev}`, id: deviceId }],
      tests: [`Try ${dev}'s cable in another device, or another cable in ${dev}`],
    });
  } else {
    // Others on the same switch.
    if (farDevice !== '') {
      const others = othersOn(doc, farDevice, deviceId);
      const names = others.map((o) => n.name(o.id));
      steps.push({
        topic: 'neighbours',
        question: others.length > 0 ? `Are the others on ${sw} working (${listNames(names)})?` : `Is anything else on ${sw} working?`,
        detail: others.length > 0 ? `Other devices cabled to ${sw}.` : `Fathom doesn't know of another device cabled to ${sw}.`,
        targets: unique([farDevice, ...others.flatMap((o) => [o.id, o.cable])]),
        why: [FIXED.neighbours, WHY_RULES['topo.switch.single-cable']],
        known: others.length > 0,
        suspects: [{ label: sw, id: farDevice }],
        tests: [`Look at ${sw}'s own lights and power`],
      });
    }
    // The link on the far-end port.
    const free = farDevice !== '' ? freePorts(doc, farDevice, up.far.port) : 0;
    const through = up.far.via.filter((v) => kindOf(v) === 'PassiveNode');
    steps.push({
      topic: 'link',
      question: farDevice !== '' ? `Link light on ${sw} ${farWord}?` : `Link light on ${nearWord}?`,
      detail: `${cableWord(doc, up.cable)}, to ${nearWord}${through.length > 0 ? `, through ${listNames(through.map((p) => n.name(p)))}` : ''}`,
      targets: unique([deviceId, up.near, up.cable, up.far.port, up.far.owner.id, ...up.far.via]),
      why: [FIXED.link, WHY_RULES['phy.link.speed-mismatch']],
      known: true,
      suspects:
        farDevice !== ''
          ? [
              { label: 'the cable', id: up.cable },
              { label: `${farWord} on ${sw}`, id: up.far.port },
            ]
          : [{ label: 'the cable', id: up.cable }],
      tests: [
        ...(farDevice !== '' && free > 0 ? [`Try ${dev} on a free port (${sw} has ${free})`] : []),
        'Try another cable between them',
      ],
    });
    // The port's state and VLAN.
    if (farDevice !== '') {
      const facts = networkFacts(doc, deviceId, up.cable, farDevice);
      const iface = edgesIn(doc, up.far.port, 'Occupies')[0]?.from;
      const adminUp = iface === undefined ? undefined : fieldValue(live(doc, iface)?.fields ?? {}, 'Interface.admin_up');
      const vlan = facts.vlan !== undefined ? `VLAN ${facts.vlan}` : '';
      steps.push({
        topic: 'port',
        question: `Is ${farWord} on ${sw} enabled${vlan !== '' ? ` and in ${vlan}` : ''}?`,
        detail:
          adminUp === false
            ? `Fathom has ${farWord} recorded as switched off.`
            : vlan === ''
              ? `Fathom has no VLAN recorded for ${farWord}.`
              : `Fathom has it ${facts.mode === 'trunk' ? 'as a trunk' : 'as an access port'} in ${vlan}.`,
        targets: unique([farDevice, up.far.port, up.cable]),
        why: [FIXED.port, WHY_RULES['l2.vlan.access-mismatch'], WHY_RULES['l2.vlan.trunk-missing']],
        known: iface !== undefined || vlan !== '',
        suspects: [{ label: `the setup of ${farWord} on ${sw}`, id: up.far.port }],
        tests: [`Check ${farWord} is enabled${vlan !== '' ? ` and in ${vlan}` : ''} on ${sw}`],
      });
    }
  }

  // Address and gateway.
  const facts = networkFacts(doc, deviceId, up?.cable ?? '', farDevice);
  const managed = field(live(doc, deviceId), 'Device.management_address');
  const address = facts.address !== undefined ? bare(facts.address) : managed;
  if (address === '') {
    steps.push({
      topic: 'address',
      question: `Does ${dev} answer?`,
      detail: `Fathom doesn't know ${dev}'s address. Try the address you use for it.`,
      targets: [deviceId],
      why: [FIXED.address, WHY_RULES['ip.address.same-on-link']],
      known: false,
      suspects: [{ label: `the address of ${dev}`, id: deviceId }],
      tests: [`From another device on the same network, try to reach ${dev}`],
    });
  } else {
    steps.push({
      topic: 'address',
      question: `Does ${address} answer?`,
      detail: `From another device on the same network, try to reach ${address}.`,
      targets: [deviceId],
      why: [FIXED.address, WHY_RULES['ip.address.same-on-link'], WHY_RULES['ip.address.different-subnet-on-link']],
      known: true,
      suspects: [{ label: `the address ${address}`, id: deviceId }],
      tests: [`Check ${dev} really holds ${address} and is on the right subnet`],
    });
  }
  const gw = facts.gateway;
  if (gw !== undefined) {
    const gname = n.name(gw.deviceId);
    steps.push({
      topic: 'gateway',
      question: `Is the gateway ${gname}${gw.address !== undefined ? ` (${bare(gw.address)})` : ''} working?`,
      detail: `${dev} reaches other networks through ${gname}.`,
      targets: unique([gw.deviceId, deviceId]),
      why: [FIXED.gateway],
      known: true,
      suspects: [{ label: gname, id: gw.deviceId }],
      tests: [`From a device on the same network, try to reach ${gname}`],
    });
  } else {
    steps.push({
      topic: 'gateway',
      question: `Can ${dev} reach other networks?`,
      detail: `Fathom doesn't know ${dev}'s gateway. Can it reach anything off its own network?`,
      targets: [deviceId],
      why: [FIXED.gateway],
      known: false,
      suspects: [{ label: `the gateway of ${dev}`, id: deviceId }],
      tests: [`From ${dev}, try to reach a device on another network`],
    });
  }
  return { deviceId, deviceName: dev, steps };
}

// ---------------------------------------------------------------------------
// Also affected

export interface Affected {
  id: string;
  name: string;
  how: 'is powered from it' | 'has no other cable';
}

const HOW_ORDER: Record<Affected['how'], number> = { 'is powered from it': 0, 'has no other cable': 1 };

/** What depends on a device: what it powers, and what has no other cable than the one to it (the maintenance
 * panel's "has no other cable"). Says what is touched, never what would go wrong. */
export function alsoAffected(doc: Document, deviceId: string): Affected[] {
  const canon = buildCanon(doc);
  const found = new Map<string, Affected['how']>();
  const set = (id: string, how: Affected['how']): void => {
    const had = found.get(id);
    if (had === undefined || HOW_ORDER[how] < HOW_ORDER[had]) found.set(id, how);
  };
  for (const port of portsOfDevice(doc, deviceId)) {
    for (const cable of cablesAt(doc, port)) {
      const far = followCable(doc, port, cable);
      if (far === null || far.owner.kind !== 'device' || far.owner.id === deviceId) continue;
      if (isPower(doc, port)) {
        // A power cable from an outlet on this device: the far device is fed by it.
        if (readPhysicalPortFields(live(doc, port)!).connector === 'c13') set(far.owner.id, 'is powered from it');
        continue;
      }
      // The far device's data ports: if every cable leads here, this is its only way.
      const cables = portsOfDevice(doc, far.owner.id)
        .filter((p) => !isPower(doc, p))
        .flatMap((p) => cablesAt(doc, p).map((c) => ({ p, c })));
      const elsewhere = cables.some(({ p, c }) => {
        const f = followCable(doc, p, c);
        return f !== null && f.owner.id !== deviceId;
      });
      if (!elsewhere) set(far.owner.id, 'has no other cable');
    }
  }
  return [...found.entries()]
    .map(([id, how]) => ({ id, name: nameOf(doc, canon, id), how }))
    .sort((a, b) => HOW_ORDER[a.how] - HOW_ORDER[b.how] || naturalCompare(a.name, b.name));
}

/** The "Also affected" lines: one sentence each way, or that nothing else depends on the device. */
export function affectedLines(deviceName: string, list: readonly Affected[]): string[] {
  if (list.length === 0) return [`Nothing else depends on ${deviceName}.`];
  const by = (how: Affected['how']): string[] => list.filter((a) => a.how === how).map((a) => a.name);
  const lines: string[] = [];
  const fed = by('is powered from it');
  if (fed.length > 0) lines.push(`${listNames(fed, 4)} ${fed.length === 1 ? 'is' : 'are'} powered from ${deviceName}.`);
  const only = by('has no other cable');
  if (only.length > 0) lines.push(`${listNames(only, 4)} ${only.length === 1 ? 'has' : 'have'} no other cable.`);
  return lines;
}
