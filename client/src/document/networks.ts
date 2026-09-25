// ADR-0058 — the VLAN and subnet commands. Same shape as `commands.ts`
// and `cables.ts`: every write is `Origin::Hand`, `Confidence::Asserted`
// provenance, one `Batch` per call, nothing written on a refusal (a throw
// before the final `withBatch` leaves the caller's `doc` untouched, since
// every edit here builds a fresh `working` document rather than mutating the
// one it was given).
//
// A network row (VLAN or subnet) is derived, never stored as a node
// (ADR-0058 decision 1, `networks-derive.ts`) — so "attach to an existing
// network" and "add a network" write the same shape: a VLAN's identity is
// its numeric id, present as a `Vlan` node on every device that
// carries it. `attachToVlan`/`attachToSubnet` are thin wrappers over
// `addVlan`/`addSubnet` that additionally refuse when nothing with that id
// or prefix exists yet, so "attach" cannot silently become "add."

import {
  LOCAL_ACTOR,
  archiveField,
  assertHand,
  edgesIn,
  edgesOut,
  familySet,
  findNode,
  formatEdgeId,
  formatNodeId,
  identifier,
  interfaceAddress,
  interfaceName as interfaceNameOf,
  ipPrefix,
  ipv4NetworkOf,
  parseEdgeId,
  parseNodeId,
  replaceNode,
  requireFieldName,
  text,
  token,
  uint,
  vlanId as vlanIdOf,
  withBatch,
  withEdge,
  withNode,
  type Batch,
  type Document,
  type FieldEntry,
  type GraphNode,
  type Op,
} from './model';
import { newUlid } from './ulid';

interface Actor {
  actor?: string;
  now?: number;
}

function resolve(opts: Actor | undefined): { actor: string; now: number } {
  return { actor: opts?.actor ?? LOCAL_ACTOR, now: opts?.now ?? Date.now() };
}

/** `commands.ts`'s private `setField`, mirrored here for the same reason
 * `cables.ts`'s copy is: it is private to its module. */
function setField(
  working: Document,
  now: number,
  actor: string,
  elementId: string,
  existing: FieldEntry | undefined,
  key: string,
  value: FieldEntry['value'],
): { doc: Document; entry: FieldEntry; op: Op } {
  requireFieldName(key);
  const prov = assertHand(working, { assertedAt: now, assertedBy: actor, supersedes: existing?.prov });
  const archived = existing !== undefined ? archiveField(prov.doc, elementId, key, existing) : prov.doc;
  return {
    doc: archived,
    entry: { presence: 'set', prov: prov.id, value },
    op: { type: 'set_field', element: elementId, key, presence: 'set', prov: prov.id },
  };
}

function fieldValue(fields: Readonly<Record<string, FieldEntry>>, name: string): FieldEntry['value'] | undefined {
  const e = fields[name];
  return e && e.presence === 'set' ? e.value : undefined;
}

function asString(v: FieldEntry['value'] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asNumber(v: FieldEntry['value'] | undefined): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function asStringArray(v: FieldEntry['value'] | undefined): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

// ---------------------------------------------------------------------------
// One error class for every refusal this module makes — `code` for a
// caller that branches on the reason, `message` for a human (each refusal
// names the reason, ADR-0058 §7).

export type NetworkRefusalCode =
  | 'unknown-reference'
  | 'vlan-id-range'
  | 'vlan-name-invalid'
  | 'device-already-has-vlan'
  | 'not-a-trunk'
  | 'unit-already-in-vlan'
  | 'second-gateway'
  | 'subnet-needs-gateway'
  | 'gateway-outside-subnet'
  | 'duplicate-interface-name'
  | 'duplicate-unit-index'
  | 'bond-attach-not-supported'
  | 'port-already-occupied'
  | 'prefix-has-host-bits'
  | 'address-outside-prefix'
  | 'wrong-family'
  | 'duplicate-address';

export class NetworkRefusalError extends Error {
  readonly code: NetworkRefusalCode;
  constructor(code: NetworkRefusalCode, message: string) {
    super(message);
    this.name = 'NetworkRefusalError';
    this.code = code;
  }
}

function refuse(code: NetworkRefusalCode, message: string): never {
  throw new NetworkRefusalError(code, message);
}

// ---------------------------------------------------------------------------
// Device-of-* — the short walks up containment this module needs, none of
// which `model.ts` exposes today (it reads only the five kinds/four edges
// session 1 drew).

function deviceOfChassisPort(doc: Document, portId: string): string | undefined {
  const hasPort = edgesIn(doc, portId, 'HasPort')[0];
  if (!hasPort) return undefined;
  return edgesIn(doc, hasPort.from, 'HasChassis')[0]?.from;
}

function deviceOfInterfaceLike(doc: Document, interfaceLikeId: string): string | undefined {
  return edgesIn(doc, interfaceLikeId, 'HasInterface')[0]?.from;
}

function unitContext(doc: Document, unitId: string): { deviceId: string; interfaceId: string } | undefined {
  const hasUnit = edgesIn(doc, unitId, 'HasUnit')[0];
  if (!hasUnit) return undefined;
  const deviceId = deviceOfInterfaceLike(doc, hasUnit.from);
  if (!deviceId) return undefined;
  return { deviceId, interfaceId: hasUnit.from };
}

// ---------------------------------------------------------------------------
// Attaching — ADR-0058 decision 2: an existing unit, a new unit on an
// existing interface, or a new Interface + HasInterface + Occupies + HasUnit
// on a bare drawn port.

export type NetworkAttachTarget =
  | { kind: 'unit'; unitId: string }
  | { kind: 'interface'; interfaceId: string }
  | { kind: 'port'; portId: string; interfaceName: string };

interface ResolvedUnit {
  working: Document;
  unitId: string;
  interfaceId: string;
  deviceId: string;
  /** True iff this call minted a fresh `LogicalUnit` — false for an
   * existing one named by a `'unit'` target. Callers use this to decide
   * whether writing `LogicalUnit.vlan_id` is this attach's unit to
   * name, or an established trunk unit nothing here may relabel. */
  created: boolean;
}

/** Resolves `target` to a `LogicalUnit`, creating an `Interface`/`LogicalUnit`
 * where ADR-0058 decision 2 says one is missing. `desiredIndex` is the index
 * a FRESHLY created unit takes (`addVlan`'s convention: the vlan id when
 * tagged, `0` when not); ignored for an existing unit. Only a member
 * `Interface` occupies a port (schema.yaml's `Occupies` doc, `~2396-2405`) —
 * a bond (`AggregateInterface`) is refused rather than built; supported only
 * if it stays cheap. */
function resolveOrCreateUnit(
  working: Document,
  now: number,
  actor: string,
  ops: Op[],
  target: NetworkAttachTarget,
  desiredIndex: number,
): ResolvedUnit {
  if (target.kind === 'unit') {
    const unit = findNode(working, target.unitId);
    if (!unit || unit.absentSince !== undefined || parseNodeId(target.unitId).kind !== 'LogicalUnit') {
      refuse('unknown-reference', `"${target.unitId}" is not a live LogicalUnit in this document`);
    }
    const ctx = unitContext(working, target.unitId);
    if (!ctx) refuse('unknown-reference', `"${target.unitId}" has no owning interface`);
    if (parseNodeId(ctx.interfaceId).kind !== 'Interface') {
      refuse(
        'bond-attach-not-supported',
        `"${ctx.interfaceId}" is a ${parseNodeId(ctx.interfaceId).kind}, not a member Interface — attaching a network onto an aggregate is not supported yet`,
      );
    }
    return { working, unitId: target.unitId, interfaceId: ctx.interfaceId, deviceId: ctx.deviceId, created: false };
  }

  let interfaceId: string;
  let deviceId: string;

  if (target.kind === 'interface') {
    const iface = findNode(working, target.interfaceId);
    if (!iface || iface.absentSince !== undefined) {
      refuse('unknown-reference', `"${target.interfaceId}" is not a live interface in this document`);
    }
    if (parseNodeId(target.interfaceId).kind !== 'Interface') {
      refuse(
        'bond-attach-not-supported',
        `"${target.interfaceId}" is a ${parseNodeId(target.interfaceId).kind} — attaching a network onto an aggregate is not supported yet`,
      );
    }
    const owner = deviceOfInterfaceLike(working, target.interfaceId);
    if (!owner) refuse('unknown-reference', `"${target.interfaceId}" has no owning device`);
    interfaceId = target.interfaceId;
    deviceId = owner;
  } else {
    const port = findNode(working, target.portId);
    if (!port || port.absentSince !== undefined || parseNodeId(target.portId).kind !== 'PhysicalPort') {
      refuse('unknown-reference', `"${target.portId}" is not a live PhysicalPort in this document`);
    }
    if (edgesIn(working, target.portId, 'Occupies').length > 0) {
      refuse('port-already-occupied', `port "${target.portId}" already has an interface — attach to it instead of drawing a new one`);
    }
    const owner = deviceOfChassisPort(working, target.portId);
    if (!owner) refuse('unknown-reference', `"${target.portId}" has no owning device`);
    deviceId = owner;

    for (const hi of edgesOut(working, deviceId, 'HasInterface')) {
      if (parseNodeId(hi.to).kind !== 'Interface') continue;
      const n = findNode(working, hi.to);
      if (!n || n.absentSince !== undefined) continue;
      if (asString(fieldValue(n.fields, 'Interface.name')) === target.interfaceName) {
        refuse('duplicate-interface-name', `interface "${target.interfaceName}" already exists on device "${deviceId}"`);
      }
    }

    const ifaceExistence = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = ifaceExistence.doc;
    const newIfaceId = formatNodeId('Interface', newUlid(now));
    const nameField = setField(working, now, actor, newIfaceId, undefined, 'Interface.name', interfaceNameOf(target.interfaceName));
    working = nameField.doc;
    const formField = setField(working, now, actor, newIfaceId, undefined, 'Interface.form', token('ethernet'));
    working = formField.doc;
    working = withNode(working, {
      id: newIfaceId,
      existence: ifaceExistence.id,
      fields: { 'Interface.name': nameField.entry, 'Interface.form': formField.entry },
    });
    ops.push({ type: 'add_node', node: newIfaceId, prov: ifaceExistence.id }, nameField.op, formField.op);

    const hasIfaceProv = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = hasIfaceProv.doc;
    const hasIfaceId = formatEdgeId('HasInterface', newUlid(now));
    working = withEdge(working, { id: hasIfaceId, from: deviceId, to: newIfaceId, prov: hasIfaceProv.id, fields: {} });
    ops.push({ type: 'add_edge', edge: hasIfaceId, from: deviceId, to: newIfaceId, prov: hasIfaceProv.id });

    const occProv = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = occProv.doc;
    const occId = formatEdgeId('Occupies', newUlid(now));
    working = withEdge(working, { id: occId, from: newIfaceId, to: target.portId, prov: occProv.id, fields: {} });
    ops.push({ type: 'add_edge', edge: occId, from: newIfaceId, to: target.portId, prov: occProv.id });

    interfaceId = newIfaceId;
  }

  for (const hu of edgesOut(working, interfaceId, 'HasUnit')) {
    const n = findNode(working, hu.to);
    if (!n || n.absentSince !== undefined) continue;
    if (asNumber(fieldValue(n.fields, 'LogicalUnit.index')) === desiredIndex) {
      refuse('duplicate-unit-index', `interface "${interfaceId}" already has a unit at index ${desiredIndex}`);
    }
  }

  const unitExistence = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = unitExistence.doc;
  const unitId = formatNodeId('LogicalUnit', newUlid(now));
  const indexField = setField(working, now, actor, unitId, undefined, 'LogicalUnit.index', uint(desiredIndex, 32));
  working = indexField.doc;
  working = withNode(working, { id: unitId, existence: unitExistence.id, fields: { 'LogicalUnit.index': indexField.entry } });
  ops.push({ type: 'add_node', node: unitId, prov: unitExistence.id }, indexField.op);

  const hasUnitProv = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = hasUnitProv.doc;
  const hasUnitId = formatEdgeId('HasUnit', newUlid(now));
  working = withEdge(working, { id: hasUnitId, from: interfaceId, to: unitId, prov: hasUnitProv.id, fields: {} });
  ops.push({ type: 'add_edge', edge: hasUnitId, from: interfaceId, to: unitId, prov: hasUnitProv.id });

  return { working, unitId, interfaceId, deviceId, created: true };
}

/** Adds `'inet'` to a unit's `families` if it is not already there — every
 * unit carrying an `Address` needs at least one family (schema.yaml's
 * doc on `LogicalUnit.families`). Safe to call on a brand-new unit (no
 * existing entry to archive) or an established one. */
function ensureFamilyInet(working: Document, now: number, actor: string, unitId: string, ops: Op[]): Document {
  const node = findNode(working, unitId);
  if (!node) return working;
  const existing = node.fields['LogicalUnit.families'];
  const current = asStringArray(existing && existing.presence === 'set' ? existing.value : undefined);
  if (current.includes('inet')) return working;
  let next: FieldEntry['value'];
  try {
    next = familySet([...current, 'inet']);
  } catch (e) {
    // familySet refuses a token this unit already carries that this
    // module's vocabulary does not declare (a real one, e.g. `vpls`,
    // read off a unit this command did not write) -- named, not a bare
    // uncaught RangeError.
    refuse('wrong-family', `unit "${unitId}" already carries an address family this version does not recognise (${e instanceof Error ? e.message : e})`);
  }
  const famField = setField(working, now, actor, unitId, existing, 'LogicalUnit.families', next);
  ops.push(famField.op);
  return replaceNode(famField.doc, unitId, (n) => ({ ...n, fields: { ...n.fields, 'LogicalUnit.families': famField.entry } }));
}

/** `LogicalUnit.vlan_id` — Junos's `vlan-id` statement on a tagged
 * unit (schema.yaml's doc), written only for a freshly cut per-vlan
 * sub-interface (`resolveOrCreateUnit`'s `created`). */
function setUnitVlanId(working: Document, now: number, actor: string, unitId: string, vlanIdValue: number, ops: Op[]): Document {
  const node = findNode(working, unitId);
  if (!node) return working;
  const existing = node.fields['LogicalUnit.vlan_id'];
  const vf = setField(working, now, actor, unitId, existing, 'LogicalUnit.vlan_id', vlanIdOf(vlanIdValue));
  ops.push(vf.op);
  return replaceNode(vf.doc, unitId, (n) => ({ ...n, fields: { ...n.fields, 'LogicalUnit.vlan_id': vf.entry } }));
}

function setDescription(working: Document, now: number, actor: string, unitId: string, description: string, ops: Op[]): Document {
  const node = findNode(working, unitId);
  if (!node) return working;
  const existing = node.fields['LogicalUnit.description'];
  const df = setField(working, now, actor, unitId, existing, 'LogicalUnit.description', text(description));
  ops.push(df.op);
  return replaceNode(df.doc, unitId, (n) => ({ ...n, fields: { ...n.fields, 'LogicalUnit.description': df.entry } }));
}

// ---------------------------------------------------------------------------
// addVlan / attachToVlan

export interface AddVlanAttachSpec {
  target: NetworkAttachTarget;
  /** Untagged (default) writes `VlanMember{access}`; tagged writes
   * `VlanMember{trunk}` and is refused unless the resolved unit already
   * carries a live trunk membership — "a trunk is never made here." */
  tagged?: boolean;
  /** Marks this attachment's unit as the VLAN's gateway: index becomes the
   * VLAN id, plus an `Address` (`gatewayAddress`, required) and an
   * `L3Interface` edge from the VLAN. At most one per call. */
  gateway?: boolean;
}

export interface AddVlanOptions {
  vlanId: number;
  name?: string;
  description?: string;
  /** Devices that get a bare `Vlan` + `HasVlan`, no member. */
  on?: readonly string[];
  attach?: readonly AddVlanAttachSpec[];
  /** The VLAN's subnet, checked against the gateway's address; requires
   * exactly one `attach` entry marked `gateway`. */
  subnet?: string;
  /** The gateway attachment's address (`InterfaceAddress`), required when
   * exactly one `attach` entry is marked `gateway`. */
  gatewayAddress?: string;
}

/** Whether `addressOrPrefix`'s IP portion falls inside `prefixText`, masking
 * by `prefixText`'s OWN length rather than `addressOrPrefix`'s (an
 * interface address's `/len` suffix names its host's mask, not
 * necessarily the exact string this check cares about) — "compare parsed
 * values, never strings" (ADR-0058 decision 5, restated for the write side
 * here too). */
function ipInPrefix(addressOrPrefix: string, prefixText: string): boolean {
  const ip = addressOrPrefix.split('/')[0];
  const net = ipv4NetworkOf(prefixText);
  const masked = ipv4NetworkOf(`${ip}/${net.len}`);
  return masked.value === net.value;
}

function vlanExistsOnDevice(doc: Document, deviceId: string, vlanIdValue: number): string | undefined {
  for (const hv of edgesOut(doc, deviceId, 'HasVlan')) {
    if (hv.absentSince !== undefined) continue;
    const vn = findNode(doc, hv.to);
    if (!vn || vn.absentSince !== undefined) continue;
    if (asString(fieldValue(vn.fields, 'Vlan.vlan_id')) === String(vlanIdValue)) return vn.id;
  }
  return undefined;
}

function vlanExistsAnywhere(doc: Document, vlanIdValue: number): boolean {
  for (const n of doc.nodes) {
    if (n.absentSince !== undefined) continue;
    if (parseNodeId(n.id).kind !== 'Vlan') continue;
    if (asString(fieldValue(n.fields, 'Vlan.vlan_id')) === String(vlanIdValue)) return true;
  }
  return false;
}

function addVlanImpl(doc: Document, opts: AddVlanOptions, actorOpts: Actor | undefined, requireExisting: boolean): Document {
  if (!Number.isInteger(opts.vlanId) || opts.vlanId < 1 || opts.vlanId > 4094) {
    refuse('vlan-id-range', `VLAN id ${opts.vlanId} is outside 1..=4094`);
  }
  if (opts.name !== undefined) {
    try {
      identifier(opts.name);
    } catch (e) {
      refuse('vlan-name-invalid', `VLAN name "${opts.name}" is not an Identifier — spaces go in description (${e instanceof Error ? e.message : e})`);
    }
  }
  if (requireExisting && !vlanExistsAnywhere(doc, opts.vlanId)) {
    refuse('unknown-reference', `no existing VLAN ${opts.vlanId} to attach to`);
  }

  const attach = opts.attach ?? [];
  const gatewayAttaches = attach.filter((a) => a.gateway === true);
  if (gatewayAttaches.length > 1) refuse('second-gateway', 'a VLAN takes at most one gateway in one add');
  if (opts.subnet !== undefined && gatewayAttaches.length === 0) {
    refuse('subnet-needs-gateway', `subnet "${opts.subnet}" was given with no gateway unit`);
  }
  if (opts.subnet !== undefined) {
    try {
      ipPrefix(opts.subnet);
    } catch {
      refuse('prefix-has-host-bits', `subnet "${opts.subnet}" is not a valid host-bits-free prefix`);
    }
  }
  if (gatewayAttaches.length === 1) {
    if (opts.gatewayAddress === undefined) {
      refuse('subnet-needs-gateway', 'the gateway attachment needs gatewayAddress');
    }
    try {
      interfaceAddress(opts.gatewayAddress);
    } catch {
      refuse('wrong-family', `gateway address "${opts.gatewayAddress}" is not a valid IPv4 host address`);
    }
    if (opts.subnet !== undefined && !ipInPrefix(opts.gatewayAddress, opts.subnet)) {
      refuse('gateway-outside-subnet', `gateway address "${opts.gatewayAddress}" is outside subnet "${opts.subnet}"`);
    }
  }

  const { actor, now } = resolve(actorOpts);
  let working = doc;
  const ops: Op[] = [];
  const vlanNodeByDevice = new Map<string, string>();

  /** `refuseIfExists` is true only for a bare `on` device: an ATTACH reuses
   * the device's existing `Vlan` (so a second port on the same device can
   * join it), and only a duplicate `on` entry is a refusal. */
  function ensureVlanOnDevice(deviceId: string, refuseIfExists: boolean): string {
    const memo = vlanNodeByDevice.get(deviceId);
    if (memo) return memo;
    const dnode = findNode(working, deviceId);
    if (!dnode || dnode.absentSince !== undefined || parseNodeId(deviceId).kind !== 'Device') {
      refuse('unknown-reference', `"${deviceId}" is not a live Device in this document`);
    }
    const existingId = vlanExistsOnDevice(working, deviceId, opts.vlanId);
    if (existingId !== undefined) {
      if (refuseIfExists) refuse('device-already-has-vlan', `device "${deviceId}" already has VLAN ${opts.vlanId}`);
      vlanNodeByDevice.set(deviceId, existingId);
      return existingId;
    }

    const vlanExistence = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = vlanExistence.doc;
    const vlanNodeId = formatNodeId('Vlan', newUlid(now));
    const idField = setField(working, now, actor, vlanNodeId, undefined, 'Vlan.vlan_id', vlanIdOf(opts.vlanId));
    working = idField.doc;
    const nodeFields: Record<string, FieldEntry> = { 'Vlan.vlan_id': idField.entry };
    const fieldOps: Op[] = [idField.op];
    if (opts.name !== undefined) {
      const nf = setField(working, now, actor, vlanNodeId, undefined, 'Vlan.name', identifier(opts.name));
      working = nf.doc;
      nodeFields['Vlan.name'] = nf.entry;
      fieldOps.push(nf.op);
    }
    if (opts.description !== undefined) {
      const df = setField(working, now, actor, vlanNodeId, undefined, 'Vlan.description', text(opts.description));
      working = df.doc;
      nodeFields['Vlan.description'] = df.entry;
      fieldOps.push(df.op);
    }
    working = withNode(working, { id: vlanNodeId, existence: vlanExistence.id, fields: nodeFields });
    ops.push({ type: 'add_node', node: vlanNodeId, prov: vlanExistence.id }, ...fieldOps);

    const hvProv = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = hvProv.doc;
    const hvId = formatEdgeId('HasVlan', newUlid(now));
    working = withEdge(working, { id: hvId, from: deviceId, to: vlanNodeId, prov: hvProv.id, fields: {} });
    ops.push({ type: 'add_edge', edge: hvId, from: deviceId, to: vlanNodeId, prov: hvProv.id });

    vlanNodeByDevice.set(deviceId, vlanNodeId);
    return vlanNodeId;
  }

  for (const deviceId of new Set(opts.on ?? [])) ensureVlanOnDevice(deviceId, true);

  for (const a of attach) {
    // A gateway is a routed sub-interface (Junos `unit <vlan-id> vlan-id
    // <vlan-id>`), not a switch trunk member — it is always tagged, its
    // unit index is the VLAN id, and "a trunk is never made here" does not
    // gate it (there is no trunk to already carry it; the sub-interface is
    // made fresh, precisely once, by this attach).
    const effectiveTagged = a.tagged === true || a.gateway === true;
    const desiredIndex = effectiveTagged ? opts.vlanId : 0;
    const resolved = resolveOrCreateUnit(working, now, actor, ops, a.target, desiredIndex);
    working = resolved.working;

    const vlanNodeId = ensureVlanOnDevice(resolved.deviceId, false);

    const existingMemberships = edgesOut(working, resolved.unitId, 'VlanMember').filter((e) => e.absentSince === undefined);
    if (effectiveTagged) {
      if (a.gateway !== true) {
        const alreadyTrunk = existingMemberships.some((e) => asString(fieldValue(e.fields, 'VlanMember.mode')) === 'trunk');
        if (!alreadyTrunk) {
          refuse('not-a-trunk', `unit "${resolved.unitId}" does not already trunk — a trunk is never made here`);
        }
      } else {
        // A gateway is a fresh sub-interface, but the RESOLVED unit can
        // still be one that already carries an access membership elsewhere
        // (a reused unit, or one this call's `resolveOrCreateUnit` matched
        // by index) — that must refuse exactly as the untagged branch below
        // does, not bypass it.
        const alreadyAccess = existingMemberships.some((e) => asString(fieldValue(e.fields, 'VlanMember.mode')) === 'access');
        if (alreadyAccess) {
          refuse('unit-already-in-vlan', `unit "${resolved.unitId}" is already an access member of another VLAN`);
        }
      }
    } else if (existingMemberships.length > 0) {
      refuse('unit-already-in-vlan', `unit "${resolved.unitId}" is already in another VLAN`);
    }

    // LogicalUnit.vlan_id names the ONE vlan a freshly cut per-vlan
    // sub-interface carries — never stamped onto a reused, already-established
    // trunk unit, which may legitimately carry several.
    if (effectiveTagged && resolved.created) {
      working = setUnitVlanId(working, now, actor, resolved.unitId, opts.vlanId, ops);
    }

    const vmProv = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = vmProv.doc;
    const vmId = formatEdgeId('VlanMember', newUlid(now));
    const modeField = setField(working, now, actor, vmId, undefined, 'VlanMember.mode', token(effectiveTagged ? 'trunk' : 'access'));
    working = modeField.doc;
    working = withEdge(working, {
      id: vmId,
      from: resolved.unitId,
      to: vlanNodeId,
      prov: vmProv.id,
      fields: { 'VlanMember.mode': modeField.entry },
    });
    ops.push({ type: 'add_edge', edge: vmId, from: resolved.unitId, to: vlanNodeId, prov: vmProv.id }, modeField.op);

    if (a.gateway === true) {
      if (edgesIn(working, resolved.unitId, 'L3Interface').some((e) => e.absentSince === undefined)) {
        refuse('second-gateway', `unit "${resolved.unitId}" is already another VLAN's gateway`);
      }
      working = ensureFamilyInet(working, now, actor, resolved.unitId, ops);

      const addrExistence = assertHand(working, { assertedAt: now, assertedBy: actor });
      working = addrExistence.doc;
      const addrId = formatNodeId('Address', newUlid(now));
      const valueField = setField(working, now, actor, addrId, undefined, 'Address.value', interfaceAddress(opts.gatewayAddress!));
      working = valueField.doc;
      const familyField = setField(working, now, actor, addrId, undefined, 'Address.family', token('inet'));
      working = familyField.doc;
      working = withNode(working, {
        id: addrId,
        existence: addrExistence.id,
        fields: { 'Address.value': valueField.entry, 'Address.family': familyField.entry },
      });
      ops.push({ type: 'add_node', node: addrId, prov: addrExistence.id }, valueField.op, familyField.op);

      const haProv = assertHand(working, { assertedAt: now, assertedBy: actor });
      working = haProv.doc;
      const haId = formatEdgeId('HasAddress', newUlid(now));
      working = withEdge(working, { id: haId, from: resolved.unitId, to: addrId, prov: haProv.id, fields: {} });
      ops.push({ type: 'add_edge', edge: haId, from: resolved.unitId, to: addrId, prov: haProv.id });

      const l3Prov = assertHand(working, { assertedAt: now, assertedBy: actor });
      working = l3Prov.doc;
      const l3Id = formatEdgeId('L3Interface', newUlid(now));
      working = withEdge(working, { id: l3Id, from: vlanNodeId, to: resolved.unitId, prov: l3Prov.id, fields: {} });
      ops.push({ type: 'add_edge', edge: l3Id, from: vlanNodeId, to: resolved.unitId, prov: l3Prov.id });
    }
  }

  const label = `${requireExisting ? 'attach to' : 'add'} VLAN ${opts.vlanId}${opts.name ? ` · ${opts.name}` : ''}`;
  const batch: Batch = { id: newUlid(now), label, ops };
  return withBatch(working, batch);
}

export function addVlan(doc: Document, opts: AddVlanOptions, actorOpts?: Actor): Document {
  return addVlanImpl(doc, opts, actorOpts, false);
}

/** A thin wrapper over [`addVlan`] that additionally refuses when VLAN
 * `vlanId` does not already exist anywhere in the document — "attach" cannot
 * silently become "add" (ADR-0058 §7's "attachToNetwork ... same
 * refusals"). The underlying write is identical: each device carries its
 * `Vlan` node (decision 1), so joining an established VLAN id from a new
 * device is the same shape as creating it there in the first place. */
export function attachToVlan(
  doc: Document,
  opts: {
    vlanId: number;
    name?: string;
    description?: string;
    target: NetworkAttachTarget;
    tagged?: boolean;
    gateway?: boolean;
    subnet?: string;
    gatewayAddress?: string;
  },
  actorOpts?: Actor,
): Document {
  return addVlanImpl(
    doc,
    {
      vlanId: opts.vlanId,
      name: opts.name,
      description: opts.description,
      on: [],
      attach: [{ target: opts.target, tagged: opts.tagged, gateway: opts.gateway }],
      subnet: opts.subnet,
      gatewayAddress: opts.gatewayAddress,
    },
    actorOpts,
    true,
  );
}

// ---------------------------------------------------------------------------
// addSubnet / attachToSubnet

export interface AddSubnetAttachSpec {
  target: NetworkAttachTarget;
  /** `InterfaceAddress` — host bits kept, e.g. `10.8.0.1/24`. */
  address: string;
  /** Writes the resolved unit's `LogicalUnit.description`. */
  name?: string;
}

export interface AddSubnetOptions {
  /** `IpPrefix` — no host bits, e.g. `10.8.0.0/24`. */
  prefix: string;
  attach: readonly AddSubnetAttachSpec[];
}

function subnetExistsAnywhere(doc: Document, prefix: string): boolean {
  for (const n of doc.nodes) {
    if (n.absentSince !== undefined) continue;
    if (parseNodeId(n.id).kind !== 'Address') continue;
    const v = asString(fieldValue(n.fields, 'Address.value'));
    if (!v) continue;
    // An IPv6 (or otherwise unparseable) existing Address must not crash
    // this scan -- it simply cannot match an IPv4 prefix, so it is
    // skipped rather than thrown on.
    try {
      if (ipInPrefix(v, prefix)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function addSubnetImpl(doc: Document, opts: AddSubnetOptions, actorOpts: Actor | undefined, requireExisting: boolean): Document {
  try {
    ipPrefix(opts.prefix);
  } catch {
    refuse('prefix-has-host-bits', `subnet "${opts.prefix}" is not a valid host-bits-free prefix`);
  }
  if (requireExisting && !subnetExistsAnywhere(doc, opts.prefix)) {
    refuse('unknown-reference', `no existing subnet ${opts.prefix} to attach to`);
  }
  if ((opts.attach ?? []).length === 0) {
    refuse('unknown-reference', 'addSubnet needs at least one attachment');
  }

  for (const a of opts.attach) {
    try {
      interfaceAddress(a.address);
    } catch {
      refuse('wrong-family', `address "${a.address}" is not a valid IPv4 address`);
    }
    if (!ipInPrefix(a.address, opts.prefix)) {
      refuse('address-outside-prefix', `address "${a.address}" is outside subnet "${opts.prefix}"`);
    }
  }

  const { actor, now } = resolve(actorOpts);
  let working = doc;
  const ops: Op[] = [];

  for (const a of opts.attach) {
    const resolved = resolveOrCreateUnit(working, now, actor, ops, a.target, 0);
    working = resolved.working;
    working = ensureFamilyInet(working, now, actor, resolved.unitId, ops);

    for (const ha of edgesOut(working, resolved.unitId, 'HasAddress')) {
      if (ha.absentSince !== undefined) continue;
      const an = findNode(working, ha.to);
      if (!an || an.absentSince !== undefined) continue;
      if (asString(fieldValue(an.fields, 'Address.value')) === a.address) {
        refuse('duplicate-address', `unit "${resolved.unitId}" already carries address "${a.address}"`);
      }
    }

    const addrExistence = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = addrExistence.doc;
    const addrId = formatNodeId('Address', newUlid(now));
    const valueField = setField(working, now, actor, addrId, undefined, 'Address.value', interfaceAddress(a.address));
    working = valueField.doc;
    const familyField = setField(working, now, actor, addrId, undefined, 'Address.family', token('inet'));
    working = familyField.doc;
    working = withNode(working, {
      id: addrId,
      existence: addrExistence.id,
      fields: { 'Address.value': valueField.entry, 'Address.family': familyField.entry },
    });
    ops.push({ type: 'add_node', node: addrId, prov: addrExistence.id }, valueField.op, familyField.op);

    const haProv = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = haProv.doc;
    const haId = formatEdgeId('HasAddress', newUlid(now));
    working = withEdge(working, { id: haId, from: resolved.unitId, to: addrId, prov: haProv.id, fields: {} });
    ops.push({ type: 'add_edge', edge: haId, from: resolved.unitId, to: addrId, prov: haProv.id });

    if (a.name !== undefined) {
      working = setDescription(working, now, actor, resolved.unitId, a.name, ops);
    }
  }

  const label = `${requireExisting ? 'attach to' : 'add'} subnet ${opts.prefix}`;
  const batch: Batch = { id: newUlid(now), label, ops };
  return withBatch(working, batch);
}

export function addSubnet(doc: Document, opts: AddSubnetOptions, actorOpts?: Actor): Document {
  return addSubnetImpl(doc, opts, actorOpts, false);
}

/** [`attachToVlan`]'s twin: refuses when `prefix` has no existing member
 * anywhere in the document. */
export function attachToSubnet(
  doc: Document,
  opts: { prefix: string; target: NetworkAttachTarget; address: string; name?: string },
  actorOpts?: Actor,
): Document {
  return addSubnetImpl(
    doc,
    { prefix: opts.prefix, attach: [{ target: opts.target, address: opts.address, name: opts.name }] },
    actorOpts,
    true,
  );
}

// ---------------------------------------------------------------------------
// Detach — tombstones only the membership edge or the Address, never the
// interface, unit or cable (ADR-0058 §7).

function requireLive(doc: Document, id: string, wantedKind: string): GraphNode {
  const n = findNode(doc, id);
  if (!n || n.absentSince !== undefined || parseNodeId(id).kind !== wantedKind) {
    refuse('unknown-reference', `"${id}" is not a live ${wantedKind} in this document`);
  }
  return n;
}

/** Removes a device's membership in a VLAN — tombstones the `VlanMember`
 * edge only. The interface, unit and any cable it carries are untouched. */
export function detachVlanMember(doc: Document, vlanMemberEdgeId: string, actorOpts?: Actor): Document {
  const e = doc.edges.find((x) => x.id === vlanMemberEdgeId);
  if (!e || e.absentSince !== undefined || parseEdgeId(vlanMemberEdgeId).kind !== 'VlanMember') {
    refuse('unknown-reference', `"${vlanMemberEdgeId}" is not a live VlanMember edge in this document`);
  }
  const { actor, now } = resolve(actorOpts);
  const working: Document = { ...doc, edges: doc.edges.map((x) => (x.id === vlanMemberEdgeId ? { ...x, absentSince: now } : x)) };
  const batch: Batch = {
    id: newUlid(now),
    label: 'detach from VLAN',
    ops: [{ type: 'tombstone', element: vlanMemberEdgeId, at: now, by: actor }],
  };
  return withBatch(working, batch);
}

/** Removes one address from a subnet — tombstones the `Address` node (and
 * its `HasAddress` edge) only. The unit, its interface and any cable it
 * carries are untouched. */
export function detachAddress(doc: Document, addressNodeId: string, actorOpts?: Actor): Document {
  requireLive(doc, addressNodeId, 'Address');
  const hasAddress = edgesIn(doc, addressNodeId, 'HasAddress')[0];
  const { actor, now } = resolve(actorOpts);
  const nodeIds = new Set([addressNodeId]);
  const edgeIds = new Set(hasAddress ? [hasAddress.id] : []);
  const working: Document = {
    ...doc,
    nodes: doc.nodes.map((n) => (nodeIds.has(n.id) ? { ...n, absentSince: now } : n)),
    edges: doc.edges.map((e) => (edgeIds.has(e.id) ? { ...e, absentSince: now } : e)),
  };
  const ops: Op[] = [...nodeIds, ...edgeIds].map((element): Op => ({ type: 'tombstone', element, at: now, by: actor }));
  const batch: Batch = { id: newUlid(now), label: 'detach address', ops };
  return withBatch(working, batch);
}

// ---------------------------------------------------------------------------
// Remove a whole network row.

/** Removes a joined VLAN row: every `Vlan` node named in `vlanNodeIds`, its
 * `HasVlan` edge, every live `VlanMember` edge that targets it, and every
 * live `L3Interface` edge from it. The gateway unit's `Address` node is
 * left in place (undoable-detach's principle, extended: nothing here
 * can tell which `Address` was written FOR this gateway and which was typed
 * separately) — it re-appears as an orphan "subnet with no VLAN" row. */
export function removeVlanNetwork(doc: Document, vlanNodeIds: readonly string[], actorOpts?: Actor): Document {
  for (const id of vlanNodeIds) requireLive(doc, id, 'Vlan');
  const { actor, now } = resolve(actorOpts);
  const nodeIds = new Set(vlanNodeIds);
  const edgeIds = new Set<string>();
  for (const id of vlanNodeIds) {
    const hv = edgesIn(doc, id, 'HasVlan')[0];
    if (hv) edgeIds.add(hv.id);
    for (const vm of edgesIn(doc, id, 'VlanMember')) edgeIds.add(vm.id);
    for (const l3 of edgesOut(doc, id, 'L3Interface')) edgeIds.add(l3.id);
  }
  const working: Document = {
    ...doc,
    nodes: doc.nodes.map((n) => (nodeIds.has(n.id) ? { ...n, absentSince: now } : n)),
    edges: doc.edges.map((e) => (edgeIds.has(e.id) ? { ...e, absentSince: now } : e)),
  };
  const ops: Op[] = [...nodeIds, ...edgeIds].map((element): Op => ({ type: 'tombstone', element, at: now, by: actor }));
  const batch: Batch = { id: newUlid(now), label: 'remove VLAN', ops };
  return withBatch(working, batch);
}

/** Removes a "subnet with no VLAN" row: every `Address` node named in
 * `addressNodeIds` and its `HasAddress` edge. The unit, its interface and
 * any cable it carries are untouched. */
export function removeSubnetNetwork(doc: Document, addressNodeIds: readonly string[], actorOpts?: Actor): Document {
  for (const id of addressNodeIds) requireLive(doc, id, 'Address');
  const { actor, now } = resolve(actorOpts);
  const nodeIds = new Set(addressNodeIds);
  const edgeIds = new Set<string>();
  for (const id of addressNodeIds) {
    const ha = edgesIn(doc, id, 'HasAddress')[0];
    if (ha) edgeIds.add(ha.id);
  }
  const working: Document = {
    ...doc,
    nodes: doc.nodes.map((n) => (nodeIds.has(n.id) ? { ...n, absentSince: now } : n)),
    edges: doc.edges.map((e) => (edgeIds.has(e.id) ? { ...e, absentSince: now } : e)),
  };
  const ops: Op[] = [...nodeIds, ...edgeIds].map((element): Op => ({ type: 'tombstone', element, at: now, by: actor }));
  const batch: Batch = { id: newUlid(now), label: 'remove subnet', ops };
  return withBatch(working, batch);
}
