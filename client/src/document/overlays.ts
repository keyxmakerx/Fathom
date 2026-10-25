// Mesh VPNs (schema 0.26, sign-off r16-overlay). An `OverlayNetwork` is a Tailscale tailnet, a
// NetBird network, a WireGuard tunnel and the like. It hangs off the root with no edge, as a Tag
// does; each member is an `OverlayMember` edge to a Device carrying that member's VPN address,
// whether it is an exit node, and the subnet routes it offers. A VPN of two members is a
// point-to-point tunnel. Entered by hand for now. No key, token or secret has a field here: the
// server refuses one typed into the name, the note or the routes. All pure, one undoable batch each.

import { begin, finish, addNode, addEdge, tombstone, type Build } from './freeform';
import {
  archiveField,
  assertHand,
  asString,
  edgesIn,
  edgesOut,
  fieldValue,
  findEdge,
  findNode,
  ipAddr,
  ipPrefix,
  kebab,
  parseNodeId,
  replaceEdge,
  replaceNode,
  requireFieldName,
  text,
  token,
  boolField,
  type Document,
  type FieldEntry,
  type GraphNode,
} from './model';

interface Actor {
  actor?: string;
  now?: number;
}

export class OverlayRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverlayRefusal';
  }
}

export const OVERLAY_PROVIDERS = ['tailscale', 'headscale', 'netbird', 'zerotier', 'wireguard', 'nebula', 'other'] as const;
export type OverlayProvider = (typeof OVERLAY_PROVIDERS)[number];

export const PROVIDER_LABEL: Record<OverlayProvider, string> = {
  tailscale: 'Tailscale',
  headscale: 'Headscale',
  netbird: 'NetBird',
  zerotier: 'ZeroTier',
  wireguard: 'WireGuard',
  nebula: 'Nebula',
  other: 'Other',
};

/** What each provider calls one of its networks, for headings. */
export const PROVIDER_NOUN: Record<OverlayProvider, string> = {
  tailscale: 'Tailnet',
  headscale: 'Tailnet',
  netbird: 'Network',
  zerotier: 'Network',
  wireguard: 'Tunnel',
  nebula: 'Network',
  other: 'VPN',
};

export const MAX_NAME = 64;
export const MAX_NOTE = 500;
export const MAX_ROUTES = 32;

const PREFIX = `${kebab('OverlayNetwork')}:`;
const live = (n: GraphNode): boolean => n.absentSince === undefined;

export interface OverlayMemberView {
  edgeId: string;
  deviceId: string;
  hostname: string;
  /** The device's chassis, which the drawing keys its boxes by. */
  chassisIds: string[];
  address: string | null;
  exitNode: boolean;
  /** Canonical prefixes, in the order typed. */
  routes: string[];
}

export interface OverlayView {
  id: string;
  name: string;
  provider: OverlayProvider;
  range: string | null;
  note: string | null;
  members: OverlayMemberView[];
}

function providerOf(raw: string | undefined): OverlayProvider {
  return (OVERLAY_PROVIDERS as readonly string[]).includes(raw ?? '') ? (raw as OverlayProvider) : 'other';
}

function readOverlay(doc: Document, n: GraphNode): OverlayView {
  const s = (key: string) => asString(fieldValue(n.fields, key));
  const members: OverlayMemberView[] = [];
  for (const e of edgesOut(doc, n.id, 'OverlayMember')) {
    const d = findNode(doc, e.to);
    if (!d || !live(d)) continue;
    const routes = asString(fieldValue(e.fields, 'OverlayMember.routes'));
    members.push({
      edgeId: e.id,
      deviceId: d.id,
      hostname: asString(fieldValue(d.fields, 'Device.hostname')) ?? '',
      chassisIds: edgesOut(doc, d.id, 'HasChassis')
        .filter((c) => findNode(doc, c.to)?.absentSince === undefined)
        .map((c) => c.to),
      address: asString(fieldValue(e.fields, 'OverlayMember.address')) ?? null,
      exitNode: fieldValue(e.fields, 'OverlayMember.exit_node') === true,
      routes: routes == null || routes === '' ? [] : routes.split('\n'),
    });
  }
  members.sort((a, b) => a.hostname.localeCompare(b.hostname) || (a.deviceId < b.deviceId ? -1 : 1));
  return { id: n.id, name: s('OverlayNetwork.name') ?? '', provider: providerOf(s('OverlayNetwork.provider')), range: s('OverlayNetwork.range') ?? null, note: s('OverlayNetwork.note') ?? null, members };
}

/** Every live VPN, by name. */
export function listOverlays(doc: Document): OverlayView[] {
  const out: OverlayView[] = [];
  for (const n of doc.nodes) if (live(n) && n.id.startsWith(PREFIX)) out.push(readOverlay(doc, n));
  return out.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}

export function overlayById(doc: Document, id: string): OverlayView | null {
  const n = findNode(doc, id);
  return n && live(n) && n.id.startsWith(PREFIX) ? readOverlay(doc, n) : null;
}

/** The VPNs a device is on, each with that device's own membership. */
export function overlaysOf(doc: Document, deviceId: string): { overlay: OverlayView; member: OverlayMemberView }[] {
  const out: { overlay: OverlayView; member: OverlayMemberView }[] = [];
  for (const e of edgesIn(doc, deviceId, 'OverlayMember')) {
    const o = overlayById(doc, e.from);
    const member = o?.members.find((m) => m.edgeId === e.id);
    if (o && member) out.push({ overlay: o, member });
  }
  return out.sort((a, b) => a.overlay.name.localeCompare(b.overlay.name));
}

// ---------------------------------------------------------------------------
// What a person types

function cleanName(raw: string): string {
  const v = raw.trim().replace(/\s+/g, ' ');
  if (v === '') throw new OverlayRefusal('Give the VPN a name.');
  if (v.length > MAX_NAME) throw new OverlayRefusal(`A name is at most ${MAX_NAME} characters.`);
  return v;
}

/** A range as a person types it: `100.64.0.0/10`. Host bits are refused, not rounded off. */
export function cleanRange(raw: string): string {
  try {
    return ipPrefix(raw.trim()) as string;
  } catch {
    throw new OverlayRefusal(`"${raw.trim()}" is not a range. Write it as an address and a length, like 100.64.0.0/10.`);
  }
}

export function cleanAddress(raw: string): string {
  try {
    return ipAddr(raw.trim()) as string;
  } catch {
    throw new OverlayRefusal(`"${raw.trim()}" is not an IPv4 address.`);
  }
}

/** Subnet routes, one per line or separated by commas; each must be a prefix, so nothing else is stored. */
export function cleanRoutes(raw: string): string[] {
  const parts = raw.split(/[\n,]/).map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length > MAX_ROUTES) throw new OverlayRefusal(`At most ${MAX_ROUTES} routes.`);
  const out: string[] = [];
  for (const p of parts) {
    let v: string;
    try {
      v = ipPrefix(p) as string;
    } catch {
      throw new OverlayRefusal(`"${p}" is not a route. Write each as a network and a length, like 10.0.10.0/24.`);
    }
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** Writes one field on a node or an edge, or clears it when `value` is undefined; nothing when nothing changes. */
function putField(b: Build, id: string, key: string, value: FieldEntry['value'] | undefined): void {
  requireFieldName(key);
  const isEdge = !id.startsWith(PREFIX);
  const element = isEdge ? findEdge(b.doc, id) : findNode(b.doc, id);
  if (!element) throw new OverlayRefusal('That is not in the design any more.');
  const existing = element.fields[key];
  const had = existing !== undefined && existing.presence === 'set' ? existing.value : undefined;
  if (had === value || (had === undefined && value === undefined)) return;
  const prov = assertHand(b.doc, { assertedAt: b.now, assertedBy: b.actor, supersedes: existing?.prov });
  b.doc = existing !== undefined ? archiveField(prov.doc, id, key, existing) : prov.doc;
  const next: FieldEntry = value === undefined ? { presence: 'absent', prov: prov.id } : { presence: 'set', prov: prov.id, value };
  b.ops.push({ type: 'set_field', element: id, key, presence: next.presence, prov: prov.id });
  b.doc = isEdge
    ? replaceEdge(b.doc, id, (e) => ({ ...e, fields: { ...e.fields, [key]: next } }))
    : replaceNode(b.doc, id, (n) => ({ ...n, fields: { ...n.fields, [key]: next } }));
}

function requireOverlay(doc: Document, id: string): OverlayView {
  const o = overlayById(doc, id);
  if (!o) throw new OverlayRefusal('That VPN is not in the design any more.');
  return o;
}

function requireDevice(doc: Document, deviceId: string): void {
  const n = findNode(doc, deviceId);
  if (!n || !live(n) || parseNodeId(deviceId).kind !== 'Device') throw new OverlayRefusal('That device is not in the design any more.');
}

// ---------------------------------------------------------------------------
// Edits

export interface OverlayPatch {
  name?: string;
  provider?: OverlayProvider;
  /** `null` or '' clears it. */
  range?: string | null;
  note?: string | null;
}

export interface MemberPatch {
  /** `null` or '' clears it. */
  address?: string | null;
  exitNode?: boolean;
  /** One prefix per line; '' clears them. */
  routes?: string;
}

function writeOverlay(b: Build, id: string, patch: OverlayPatch): void {
  if (patch.name !== undefined) putField(b, id, 'OverlayNetwork.name', text(cleanName(patch.name)));
  if (patch.provider !== undefined) putField(b, id, 'OverlayNetwork.provider', token(providerOf(patch.provider)));
  if (patch.range !== undefined) putField(b, id, 'OverlayNetwork.range', patch.range == null || patch.range.trim() === '' ? undefined : cleanRange(patch.range));
  if (patch.note !== undefined) {
    const note = patch.note?.trim() ?? '';
    if (note.length > MAX_NOTE) throw new OverlayRefusal(`A note is at most ${MAX_NOTE} characters.`);
    putField(b, id, 'OverlayNetwork.note', note === '' ? undefined : text(note));
  }
}

function writeMember(b: Build, edgeId: string, patch: MemberPatch): void {
  if (patch.address !== undefined) putField(b, edgeId, 'OverlayMember.address', patch.address == null || patch.address.trim() === '' ? undefined : cleanAddress(patch.address));
  if (patch.exitNode !== undefined) putField(b, edgeId, 'OverlayMember.exit_node', patch.exitNode ? boolField(true) : undefined);
  if (patch.routes !== undefined) {
    const routes = cleanRoutes(patch.routes);
    putField(b, edgeId, 'OverlayMember.routes', routes.length === 0 ? undefined : text(routes.join('\n')));
  }
}

export interface NewOverlay {
  name: string;
  provider: OverlayProvider;
  range?: string;
  note?: string;
  members?: readonly ({ deviceId: string } & MemberPatch)[];
}

/** Makes a VPN with its first members. One undo step. */
export function addOverlay(doc: Document, input: NewOverlay, opts?: Actor): { doc: Document; id: string } {
  const name = cleanName(input.name);
  const b = begin(doc, opts);
  const id = addNode(b, 'OverlayNetwork', { 'OverlayNetwork.name': text(name), 'OverlayNetwork.provider': token(providerOf(input.provider)) });
  writeOverlay(b, id, { range: input.range, note: input.note });
  const seen = new Set<string>();
  for (const m of input.members ?? []) {
    if (seen.has(m.deviceId)) continue;
    seen.add(m.deviceId);
    requireDevice(b.doc, m.deviceId);
    const edgeId = addEdge(b, 'OverlayMember', id, m.deviceId);
    writeMember(b, edgeId, m);
  }
  return { doc: finish(b, 'add VPN'), id };
}

/** Changes a VPN's name, provider, range or note; what is left out is left as it is. One undo step. */
export function setOverlay(doc: Document, id: string, patch: OverlayPatch, opts?: Actor): Document {
  requireOverlay(doc, id);
  const b = begin(doc, opts);
  writeOverlay(b, id, patch);
  return finish(b, 'change VPN');
}

/** Puts a device on a VPN, or changes its membership when it is on already. One undo step. */
export function setMember(doc: Document, overlayId: string, deviceId: string, patch: MemberPatch, opts?: Actor): Document {
  const o = requireOverlay(doc, overlayId);
  requireDevice(doc, deviceId);
  const b = begin(doc, opts);
  const edgeId = o.members.find((m) => m.deviceId === deviceId)?.edgeId ?? addEdge(b, 'OverlayMember', overlayId, deviceId);
  writeMember(b, edgeId, patch);
  return finish(b, 'change VPN member');
}

/** Takes a device off a VPN. The device and the VPN stay. */
export function removeMember(doc: Document, overlayId: string, deviceId: string, opts?: Actor): Document {
  const o = requireOverlay(doc, overlayId);
  const edges = edgesOut(doc, o.id, 'OverlayMember').filter((e) => e.to === deviceId);
  if (edges.length === 0) return doc;
  const b = begin(doc, opts);
  tombstone(b, new Set(), new Set(edges.map((e) => e.id)));
  return finish(b, 'remove VPN member');
}

/** Removes a VPN and its memberships. The devices stay. */
export function removeOverlay(doc: Document, id: string, opts?: Actor): Document {
  const o = requireOverlay(doc, id);
  const b = begin(doc, opts);
  tombstone(b, new Set([o.id]), new Set(edgesOut(doc, o.id, 'OverlayMember').map((e) => e.id)));
  return finish(b, 'remove VPN');
}
