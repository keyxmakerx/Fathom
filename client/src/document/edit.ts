// The one editor's writes (ADR-0046 §2, "the inspector on the drawing and
// the page in the inventory are one component"; UI-SPEC "The editor" and
// "Screens" — first press selects a value, second press edits it). This
// module is what a commit actually does to the graph: four fields, each one
// `Origin::Hand` batch built the same shape `commands.ts` builds (`assertHand`
// mints a fresh provenance record, `supersedes` the field's previous one when
// it had one). Nothing here reads a rendered view or touches a DOM node —
// `Editor.tsx` raises a request, `RacksPlace.tsx` calls the matching function
// below, and the new `Document` is what actually gets saved.
//
// The four fields are exactly the ones `schema/schema.yaml` declares for
// `Device` and `Chassis` that this session's editor exposes (CLAUDE.md rule
// 3 — a field not in `schema/` does not exist, and neither does a fifth one
// here): `Device.hostname`, `Device.role`, `Device.management_address`,
// `Chassis.serial`.

import { UnknownReferenceError } from './commands';
import {
  LOCAL_ACTOR,
  assertHand,
  findNode,
  identifier,
  replaceNode,
  requireFieldName,
  text,
  token,
  withBatch,
  type Batch,
  type Document,
  type FieldEntry,
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

/** Refused: the typed text does not fit the field's declared type, or (for
 * `Device.role`) is not one of the schema's own enum tokens. Never thrown
 * for an unknown element — that stays `UnknownReferenceError`, `commands.ts`'s
 * own class, reused rather than duplicated. */
export class FieldValueError extends Error {
  readonly field: string;
  readonly value: string;
  constructor(field: string, value: string, reason: string) {
    super(`${field}: "${value}" ${reason}`);
    this.name = 'FieldValueError';
    this.field = field;
    this.value = value;
  }
}

// `schema/schema.yaml`'s `Device.role` — the inline enum, verbatim, and the
// only source of what a role may say (`role`'s values ARE the enum, never a
// free string, this session's brief). Kept here rather than guessed from the
// wire token registry, which carries field names, not their token sets.
export const DEVICE_ROLES = [
  'firewall',
  'router',
  'switch',
  'load_balancer',
  'server',
  'access_point',
  'other',
] as const;

export type DeviceRole = (typeof DEVICE_ROLES)[number];

export function isDeviceRole(s: string): s is DeviceRole {
  return (DEVICE_ROLES as readonly string[]).includes(s);
}

// `Device.management_address` is `IpAddr` (`schema/schema.yaml`): a literal
// address, the same shape `crates/fathom-ir/src/scalar.rs`'s `IpAddr` parses
// via Rust's own `std::net::IpAddr::from_str`. Reimplemented here only as far
// as refusing an obviously malformed address before it is ever written — the
// canonical check is the engine's, not this browser's.
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6_RE =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|::(ffff(:0{1,4})?:)?((25[0-5]|(2[0-4]|1?\d)?\d)\.){3}(25[0-5]|(2[0-4]|1?\d)?\d)|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1?\d)?\d)\.){3}(25[0-5]|(2[0-4]|1?\d)?\d))$/;

export function isIpAddr(s: string): boolean {
  return IPV4_RE.test(s) || IPV6_RE.test(s);
}

function identifierOrRefuse(field: string, value: string): FieldEntry['value'] {
  try {
    return identifier(value);
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'is not a valid identifier';
    throw new FieldValueError(field, value, reason);
  }
}

/** One field's new entry plus the op that records it — `commands.ts`'s
 * `setField`, mirrored here so `edit.ts` does not reach into a sibling
 * module's private helper. */
function setFieldEntry(
  working: Document,
  now: number,
  actor: string,
  elementId: string,
  existing: FieldEntry | undefined,
  key: string,
  value: FieldEntry['value'] | undefined,
): { doc: Document; entry: FieldEntry; op: Op } {
  requireFieldName(key);
  const prov = assertHand(working, { assertedAt: now, assertedBy: actor, supersedes: existing?.prov });
  const entry: FieldEntry =
    value === undefined ? { presence: 'absent', prov: prov.id } : { presence: 'set', prov: prov.id, value };
  return {
    doc: prov.doc,
    entry,
    op: { type: 'set_field', element: elementId, key, presence: value === undefined ? 'absent' : 'set', prov: prov.id },
  };
}

function commitField(
  doc: Document,
  now: number,
  elementId: string,
  key: string,
  entry: FieldEntry,
  op: Op,
  label: string,
): Document {
  const working = replaceNode(doc, elementId, (n) => ({ ...n, fields: { ...n.fields, [key]: entry } }));
  const batch: Batch = { id: newUlid(now), label, ops: [op] };
  return withBatch(working, batch);
}

export type DeviceFieldKey = 'hostname' | 'role' | 'management_address';
export type ChassisFieldKey = 'serial';

/**
 * `Device.hostname` (`Identifier`), `Device.role` (the enum above) or
 * `Device.management_address` (`IpAddr`) on one `Device` node — pure, one
 * `Origin::Hand` batch, `value: null` clears the field (UI-SPEC "Absent is
 * drawn as absent": a cleared field is `presence: 'absent'`, never `""`).
 */
export function setDeviceField(
  doc: Document,
  deviceId: string,
  key: DeviceFieldKey,
  value: string | null,
  opts?: Actor,
): Document {
  const node = findNode(doc, deviceId);
  if (!node) throw new UnknownReferenceError(deviceId, 'Device');
  const wireKey = `Device.${key}`;

  let encoded: FieldEntry['value'] | undefined;
  if (value !== null) {
    switch (key) {
      case 'hostname':
        encoded = identifierOrRefuse(wireKey, value);
        break;
      case 'role':
        if (!isDeviceRole(value)) {
          throw new FieldValueError(wireKey, value, `is not one of: ${DEVICE_ROLES.join(', ')}`);
        }
        encoded = token(value);
        break;
      case 'management_address':
        if (!isIpAddr(value)) {
          throw new FieldValueError(wireKey, value, 'is not a valid IPv4 or IPv6 address');
        }
        encoded = text(value);
        break;
    }
  }

  const { actor, now } = resolve(opts);
  const built = setFieldEntry(doc, now, actor, deviceId, node.fields[wireKey], wireKey, encoded);
  return commitField(built.doc, now, deviceId, wireKey, built.entry, built.op, `set ${wireKey}`);
}

/**
 * `Chassis.serial` (`Identifier`) on one `Chassis` node — the same shape as
 * `setDeviceField`, for the one Chassis field this editor exposes.
 */
export function setChassisField(
  doc: Document,
  chassisId: string,
  key: ChassisFieldKey,
  value: string | null,
  opts?: Actor,
): Document {
  const node = findNode(doc, chassisId);
  if (!node) throw new UnknownReferenceError(chassisId, 'Chassis');
  const wireKey = `Chassis.${key}`;

  const encoded: FieldEntry['value'] | undefined = value !== null ? identifierOrRefuse(wireKey, value) : undefined;

  const { actor, now } = resolve(opts);
  const built = setFieldEntry(doc, now, actor, chassisId, node.fields[wireKey], wireKey, encoded);
  return commitField(built.doc, now, chassisId, wireKey, built.entry, built.op, `set ${wireKey}`);
}
