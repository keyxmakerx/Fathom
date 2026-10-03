// Typing an address, prefix or VLAN in Inventory writes it to the thing it belongs on: an Address
// on a device interface's unit, a Vlan on a device. This only picks the owner and calls the
// ADR-0058 commands, so there is one way to write each. Several writes fold into one undo step.

import { foldFrom } from './freeform';
import { edgesIn, edgesOut, findNode, parseNodeId, readDeviceFields, readPhysicalPortFields, type Document } from './model';
import { NetworkRefusalError, addSubnet, addVlan, type Actor, type NetworkAttachTarget } from './networks';
import { parseCidr, prefixText, rangeOf } from './ipam';

export class IpamRefusal extends Error {}

export const NEEDS_OWNER = 'Put it on a device interface.';

export interface OwnerChoice {
  /** `unit:<id>`, `interface:<id>` or `port:<id>`. */
  value: string;
  label: string;
  target: NetworkAttachTarget;
}

const liveNode = (doc: Document, id: string) => {
  const n = findNode(doc, id);
  return n && n.absentSince === undefined ? n : undefined;
};

export function deviceChoices(doc: Document): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  for (const n of doc.nodes) {
    if (n.absentSince === undefined && parseNodeId(n.id).kind === 'Device') out.push({ id: n.id, name: readDeviceFields(n).hostname || 'unnamed' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Where an address can go on a device: its interfaces (on the unit they already have), and drawn ports with no interface yet. */
export function interfaceChoices(doc: Document, deviceId: string): OwnerChoice[] {
  const out: OwnerChoice[] = [];
  const named = new Set<string>();
  for (const hi of edgesOut(doc, deviceId, 'HasInterface')) {
    const iface = liveNode(doc, hi.to);
    if (!iface || parseNodeId(iface.id).kind !== 'Interface') continue;
    const e = iface.fields['Interface.name'];
    const label = e && e.presence === 'set' && typeof e.value === 'string' ? e.value : iface.id.slice(-6);
    named.add(label);
    const units = edgesOut(doc, iface.id, 'HasUnit')
      .map((u) => liveNode(doc, u.to))
      .filter((u): u is NonNullable<typeof u> => u !== undefined);
    // The plain unit (index 0), never a VLAN sub-interface: a new address goes on the interface itself.
    const unit = units.find((u) => {
      const f = u.fields['LogicalUnit.index'];
      return f && f.presence === 'set' && f.value === 0;
    });
    out.push(
      unit
        ? { value: `unit:${unit.id}`, label, target: { kind: 'unit', unitId: unit.id } }
        : { value: `interface:${iface.id}`, label, target: { kind: 'interface', interfaceId: iface.id } },
    );
  }
  const chassis = edgesOut(doc, deviceId, 'HasChassis')[0]?.to;
  for (const hp of chassis ? edgesOut(doc, chassis, 'HasPort') : []) {
    const port = liveNode(doc, hp.to);
    if (!port || edgesIn(doc, port.id, 'Occupies').length > 0) continue;
    const label = readPhysicalPortFields(port).label;
    if (!label || named.has(label)) continue;
    out.push({ value: `port:${port.id}`, label: `${label} (port)`, target: { kind: 'port', portId: port.id, interfaceName: label } });
  }
  return out;
}

/** The refusals people hit, in plain words; anything else keeps the command's own message. */
function plain(e: unknown, ctx: { prefix?: string; vlanId?: number }): IpamRefusal {
  if (e instanceof IpamRefusal) return e;
  if (e instanceof NetworkRefusalError) {
    switch (e.code) {
      case 'prefix-has-host-bits':
        return new IpamRefusal(`${ctx.prefix ?? 'That'} is not a network address. Write it like 10.0.20.0/24.`);
      case 'wrong-family':
        return new IpamRefusal('That is not an IPv4 address. Only IPv4 can be added here.');
      case 'address-outside-prefix':
        return new IpamRefusal(`That address is not inside ${ctx.prefix ?? 'the prefix'}.`);
      case 'duplicate-address':
        return new IpamRefusal('That interface already has this address.');
      case 'vlan-id-range':
        return new IpamRefusal('A VLAN number is 1 to 4094.');
      case 'vlan-name-invalid':
        return new IpamRefusal('A VLAN name has no spaces. Use dashes or underscores.');
      case 'device-already-has-vlan':
        return new IpamRefusal(`That device already has VLAN ${ctx.vlanId ?? ''}.`.replace(' .', '.'));
      default:
        return new IpamRefusal(e.message);
    }
  }
  return new IpamRefusal(e instanceof Error ? e.message : 'That was refused.');
}

/**
 * Puts `address` (with its mask, e.g. 10.0.20.17/24) on the chosen interface. `prefix` is the network
 * it must sit in; leave it out to take it from the address. No owner means no write.
 */
export function addAddress(doc: Document, input: { prefix?: string; address: string; owner: OwnerChoice | null }, actor?: Actor): Document {
  if (!input.owner) throw new IpamRefusal(NEEDS_OWNER);
  const cidr = parseCidr(input.address);
  let prefix = input.prefix;
  if (!prefix) {
    if (!cidr || !input.address.includes('/')) throw new IpamRefusal('Write the address with its mask, like 10.0.20.17/24.');
    prefix = prefixText(rangeOf(cidr.ip, cidr.len));
  }
  try {
    return addSubnet(doc, { prefix, attach: [{ target: input.owner.target, address: input.address.trim() }] }, actor);
  } catch (e) {
    throw plain(e, { prefix });
  }
}

/** A VLAN on a device (a bare Vlan node; ports join it on the canvas or from Networks). */
export function addVlanOnDevice(doc: Document, input: { vlanId: number; name?: string; deviceId: string | null }, actor?: Actor): Document {
  if (!input.deviceId) throw new IpamRefusal('Put it on a device.');
  try {
    return addVlan(doc, { vlanId: input.vlanId, name: input.name || undefined, on: [input.deviceId] }, actor);
  } catch (e) {
    throw plain(e, { vlanId: input.vlanId });
  }
}

// ---------------------------------------------------------------------------
// Paste

/** The writes made since batch `from`, as one undo step. */
function oneStep(doc: Document, from: number, label: string): Document {
  const folded = foldFrom(doc, from);
  if (folded.batches.length <= from) return folded;
  return { ...folded, batches: folded.batches.map((b, i) => (i === from ? { ...b, label } : b)) };
}

const norm = (s: string) => s.trim().toLowerCase();

function headerIndex(header: readonly string[], names: readonly string[]): number {
  return header.findIndex((h) => names.includes(norm(h)));
}

export interface PastePlanResult {
  doc: Document;
  done: number;
  refused: string[];
}

function deviceByName(doc: Document, name: string): string | null | undefined {
  const hits = deviceChoices(doc).filter((d) => norm(d.name) === norm(name));
  return hits.length === 1 ? hits[0]!.id : hits.length === 0 ? undefined : null;
}

function ownerFor(doc: Document, deviceText: string, ifaceText: string): { owner: OwnerChoice | null; why?: string } {
  if (!deviceText.trim() || !ifaceText.trim()) return { owner: null };
  const id = deviceByName(doc, deviceText);
  if (id === undefined) return { owner: null, why: `no device called ${deviceText.trim()}` };
  if (id === null) return { owner: null, why: `${deviceText.trim()} names more than one device` };
  const choice = interfaceChoices(doc, id).find((c) => norm(c.label.replace(/ \(port\)$/, '')) === norm(ifaceText));
  return choice ? { owner: choice } : { owner: null, why: `${deviceText.trim()} has no interface ${ifaceText.trim()}` };
}

/** Rows of Prefix, Address, Device, Interface (a header row names them). Each row is one address on one interface. */
export function pastePrefixRows(doc: Document, table: string[][], actor?: Actor): PastePlanResult {
  const header = table[0] ?? [];
  const ci = {
    prefix: headerIndex(header, ['prefix', 'network', 'subnet']),
    address: headerIndex(header, ['address', 'ip', 'ip address']),
    device: headerIndex(header, ['device', 'host', 'hostname', 'on']),
    iface: headerIndex(header, ['interface', 'port', 'if']),
  };
  const hasHeader = ci.prefix >= 0 || ci.address >= 0;
  const body = hasHeader ? table.slice(1) : table;
  const at = hasHeader ? ci : { prefix: 0, address: 1, device: 2, iface: 3 };
  let working = doc;
  let done = 0;
  const refused: string[] = [];
  for (const cells of body) {
    const cell = (i: number) => (i >= 0 ? (cells[i] ?? '').trim() : '');
    const prefix = cell(at.prefix);
    const address = cell(at.address);
    const label = prefix || address || 'row';
    const { owner, why } = ownerFor(working, cell(at.device), cell(at.iface));
    try {
      if (!address) throw new IpamRefusal(`${NEEDS_OWNER} Give an address too.`);
      if (!owner) throw new IpamRefusal(why ? `${NEEDS_OWNER} (${why})` : NEEDS_OWNER);
      working = addAddress(working, { prefix: prefix || undefined, address, owner }, actor);
      done += 1;
    } catch (e) {
      refused.push(`${label}: ${e instanceof Error ? e.message : 'refused'}`);
    }
  }
  return { doc: oneStep(working, doc.batches.length, 'paste addresses'), done, refused };
}

/** Rows of VLAN (number), Name, Device. Each row puts one VLAN on one device. */
export function pasteVlanRows(doc: Document, table: string[][], actor?: Actor): PastePlanResult {
  const header = table[0] ?? [];
  const ci = {
    id: headerIndex(header, ['vlan', 'vlan id', 'id', 'vid']),
    name: headerIndex(header, ['name', 'vlan name']),
    device: headerIndex(header, ['device', 'host', 'hostname', 'on']),
  };
  const hasHeader = ci.id >= 0;
  const body = hasHeader ? table.slice(1) : table;
  const at = hasHeader ? ci : { id: 0, name: 1, device: 2 };
  let working = doc;
  let done = 0;
  const refused: string[] = [];
  for (const cells of body) {
    const cell = (i: number) => (i >= 0 ? (cells[i] ?? '').trim() : '');
    const idText = cell(at.id);
    try {
      if (!/^\d+$/.test(idText)) throw new IpamRefusal('A VLAN number is 1 to 4094.');
      const deviceId = cell(at.device) ? deviceByName(working, cell(at.device)) : null;
      if (deviceId === undefined) throw new IpamRefusal(`Put it on a device (no device called ${cell(at.device)}).`);
      if (deviceId === null && cell(at.device)) throw new IpamRefusal(`${cell(at.device)} names more than one device.`);
      working = addVlanOnDevice(working, { vlanId: Number(idText), name: cell(at.name), deviceId }, actor);
      done += 1;
    } catch (e) {
      refused.push(`VLAN ${idText || 'row'}: ${e instanceof Error ? e.message : 'refused'}`);
    }
  }
  return { doc: oneStep(working, doc.batches.length, 'paste VLANs'), done, refused };
}
