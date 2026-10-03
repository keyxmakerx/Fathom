// The Inventory table's row and column model, one set per kind (ADR-0062). Pure: no React, no
// save. A row is a flat bag of display text plus the ids an edit needs; an edit goes through
// `applyEditorChange`, `tagObject` or `setFieldValues`, so the table writes the same changes the
// canvas editor does (ADR-0046: one editor).

import { applyEditorChange } from '../design/applyChange';
import { addRack } from '../racks/emptyDesign';
import { createSketchDevice } from '../../document/commands';
import type { CatalogueModel } from '../../api/catalogue';
import { SHEATH_VALUES, OWNERSHIP_VALUES } from '../../document/cables';
import { DEVICE_ROLES } from '../../document/edit';
import { FIELD_TYPE_LABEL, fieldsOf, listFieldDefs, setFieldValues, type FieldDefView, type FieldFor, type FieldSet, type FieldType } from '../../document/fields';
import { edgesIn, findNode, parseNodeId, readChassisFields, readDeviceFields, type Document } from '../../document/model';
import { tagObject, tagsOf, untagObject } from '../../document/tags';
import type { SubnetRow } from '../../document/networks-derive';
import { vlanLabel, type PrefixRow, type VlanKindRow } from '../../document/ipam';
import type { CableEnd, ClosetView, Selection } from '../drawing/contract';
import { ABSENT } from '../drawing/contract';
import type { Lens } from '../shell/lens';
import { formatLastChange, groupDeviceRows, whereText, type DeviceRow } from './rows';

export type Kind = 'devices' | 'ports' | 'racks' | 'cables' | 'networks' | 'prefixes' | 'vlans' | 'addresses';
/** The side list's kinds in quiet groups. Docs, Maintenance and Issues are not built, so not listed. */
export const KIND_GROUPS: ReadonlyArray<ReadonlyArray<{ key: Kind; label: string }>> = [
  [
    { key: 'devices', label: 'Devices' },
    { key: 'ports', label: 'Ports' },
    { key: 'racks', label: 'Racks' },
    { key: 'cables', label: 'Cables' },
  ],
  [
    { key: 'networks', label: 'Networks' },
    { key: 'prefixes', label: 'Prefixes' },
    { key: 'vlans', label: 'VLANs' },
    { key: 'addresses', label: 'Addresses' },
  ],
];
export const KINDS: ReadonlyArray<{ key: Kind; label: string }> = KIND_GROUPS.flat();
export const isKind = (s: string): s is Kind => KINDS.some((k) => k.key === s);

/** The field kind a table kind's rows take; networks and addresses take none here. */
export const FIELD_FOR_KIND: Partial<Record<Kind, FieldFor>> = {
  devices: 'device',
  racks: 'rack',
  cables: 'cable',
  ports: 'port',
};

export type CellType = 'text' | 'select' | FieldType | 'tags' | 'bar';

export interface Column {
  /** A core key, `tags`, or `field:<defId>`. */
  key: string;
  label: string;
  width: number;
  editable: boolean;
  type: CellType;
  options?: readonly string[];
  defId?: string;
}

export interface InvRow {
  key: string;
  /** What the page opens: `EditorFor`'s own selection. Null for a row with no editor page. */
  selection: Selection | null;
  /** The node tags, fields and notes hang off. */
  ownerId: string | null;
  cells: Readonly<Record<string, string>>;
  tags: readonly string[];
  /** Ids a core edit needs. */
  ids: { deviceId?: string; chassisId?: string; rackId?: string; cableId?: string };
  /** Words for the page header. */
  title: string;
  /** Numbers to sort a column by when its text sorts badly (a prefix, a fill). */
  sort?: Readonly<Record<string, number>>;
  /** 0..1 for a `bar` column. */
  meter?: Readonly<Record<string, number>>;
  /** A Device-row's name, for jumping to it from an address. */
  deviceNodeId?: string;
  /** Numbers for the query language where the cell is words ("5 of 42U"). */
  nums?: Readonly<Record<string, number>>;
  /** Extra values the query language can ask about that no column shows (a cable's far end). */
  facets?: Readonly<Record<string, readonly string[]>>;
}

// ---------------------------------------------------------------------------
// Columns

const core = (key: string, label: string, width: number, extra: Partial<Column> = {}): Column => ({
  key,
  label,
  width,
  editable: false,
  type: 'text',
  ...extra,
});

const TAGS_COLUMN: Column = { key: 'tags', label: 'Tags', width: 160, editable: true, type: 'tags' };

const CORE_COLUMNS: Record<Kind, readonly Column[]> = {
  devices: [
    core('name', 'Name', 150, { editable: true }),
    core('model', 'Model', 130),
    core('role', 'Role', 110, { editable: true, type: 'select', options: DEVICE_ROLES }),
    core('mgmt', 'Mgmt address', 130, { editable: true }),
    core('serial', 'Serial', 110, { editable: true }),
    core('where', 'Where', 150),
    core('ports', 'Ports', 80),
    core('power', 'Power', 90),
    core('inlets', 'Inlets', 150),
    core('cables', 'Cables', 130),
    core('lastChange', 'Last change', 110),
  ],
  racks: [
    core('name', 'Name', 150, { editable: true }),
    core('height', 'Height (U)', 90, { editable: true }),
    core('row', 'Row', 90, { editable: true }),
    core('bay', 'Bay', 70, { editable: true }),
    core('used', 'Used', 100),
    core('devices', 'Devices', 80),
    core('free', 'Free', 80),
  ],
  cables: [
    core('name', 'Label', 140, { editable: true }),
    core('kind', 'Kind', 80),
    core('media', 'Media', 90),
    core('sheath', 'Sheath', 100, { editable: true, type: 'select', options: SHEATH_VALUES }),
    core('length', 'Length (m)', 90, { editable: true }),
    core('ownership', 'Ownership', 100, { editable: true, type: 'select', options: OWNERSHIP_VALUES }),
    core('endA', 'End A', 170),
    core('endB', 'End B', 170),
  ],
  ports: [
    core('name', 'Port', 110),
    core('device', 'Device', 140),
    core('connector', 'Connector', 100),
    core('service', 'Service', 100),
    core('face', 'Face', 70),
    core('uplink', 'Uplink', 70),
    core('cable', 'Cable to', 190),
  ],
  networks: [],
  prefixes: [
    core('prefix', 'Prefix', 150),
    core('vlan', 'VLAN', 130),
    core('site', 'Site', 120),
    core('used', 'Used', 200, { type: 'bar' }),
    core('gateway', 'Gateway', 190),
  ],
  vlans: [
    core('vlan', 'VLAN', 80),
    core('label', 'Name', 140),
    core('prefixes', 'Prefixes', 180),
    core('site', 'Site', 120),
    core('devices', 'Devices', 220),
    core('members', 'Members', 90),
  ],
  addresses: [
    core('address', 'Address', 150),
    core('interface', 'Interface', 120),
    core('device', 'Device', 140),
    core('subnet', 'Subnet', 140),
  ],
};

/** Which core columns show before anyone chooses; a lens only moves the device defaults. */
export function defaultColumnKeys(kind: Kind, lens: Lens): string[] {
  if (kind === 'devices') {
    const middle = lens === 'cables' ? 'cables' : lens === 'power' ? 'inlets' : 'ports';
    return ['name', 'model', 'where', middle, 'power', 'tags', 'lastChange'].filter((k) => !(k === 'power' && lens === 'power'));
  }
  if (kind === 'racks') return ['name', 'height', 'row', 'bay', 'used', 'devices', 'tags'];
  if (kind === 'cables') return ['name', 'kind', 'sheath', 'length', 'endA', 'endB', 'tags'];
  if (kind === 'ports') return ['name', 'device', 'connector', 'face', 'cable', 'tags'];
  if (kind === 'addresses') return ['address', 'interface', 'device', 'subnet'];
  if (kind === 'prefixes') return ['prefix', 'vlan', 'site', 'used', 'gateway'];
  if (kind === 'vlans') return ['vlan', 'label', 'prefixes', 'site', 'devices', 'members'];
  return [];
}

/** Every column the kind can show: core, tags, then one per custom field. */
export function allColumns(kind: Kind, defs: readonly FieldDefView[]): Column[] {
  const cols: Column[] = [...CORE_COLUMNS[kind]];
  if (kind === 'addresses' || kind === 'networks' || kind === 'prefixes' || kind === 'vlans') return cols;
  cols.push(TAGS_COLUMN);
  const fieldFor = FIELD_FOR_KIND[kind];
  if (fieldFor) {
    for (const def of listFieldDefs(defs, fieldFor)) {
      cols.push({
        key: `field:${def.id}`,
        label: def.name,
        width: def.type === 'text' ? 140 : 100,
        editable: true,
        type: def.type === 'choice' ? 'select' : def.type,
        options: def.type === 'choice' ? def.choices : undefined,
        defId: def.id,
      });
    }
  }
  return cols;
}

export { FIELD_TYPE_LABEL };

// ---------------------------------------------------------------------------
// Rows

function withExtras(doc: Document, kind: Kind, ownerId: string | null, cells: Record<string, string>, defs: readonly FieldDefView[]): { cells: Record<string, string>; tags: string[] } {
  const tags: string[] = [];
  if (ownerId) {
    for (const t of tagsOf(doc, ownerId)) tags.push(t.name);
    const fieldFor = FIELD_FOR_KIND[kind];
    if (fieldFor) {
      for (const f of fieldsOf(doc, ownerId, defs)) {
        if (!f.removed) cells[`field:${f.def.id}`] = f.value ?? '';
      }
    }
  }
  cells.tags = tags.join(', ');
  return { cells, tags };
}

function deviceInfo(doc: Document, chassisId: string): { deviceId: string; hostname: string; role: string; mgmt: string; serial: string } {
  const has = edgesIn(doc, chassisId, 'HasChassis')[0];
  const deviceNode = has ? findNode(doc, has.from) : undefined;
  const dev = deviceNode ? readDeviceFields(deviceNode) : undefined;
  const str = (key: string): string => {
    const e = deviceNode?.fields[key];
    return e && e.presence === 'set' && typeof e.value === 'string' ? e.value : '';
  };
  const chassisNode = findNode(doc, chassisId);
  const ch = chassisNode ? readChassisFields(chassisNode) : undefined;
  return {
    deviceId: has?.from ?? '',
    hostname: dev?.hostname ?? '',
    role: str('Device.role'),
    mgmt: str('Device.management_address'),
    serial: ch?.serial ?? '',
  };
}

export function deviceRows(doc: Document, view: ClosetView, defs: readonly FieldDefView[] = []): InvRow[] {
  const out: InvRow[] = [];
  for (const group of groupDeviceRows(view, doc)) {
    for (const r of group.rows as DeviceRow[]) {
      const chassisId = r.selection.id;
      const info = deviceInfo(doc, chassisId);
      const ownerId = info.deviceId || null;
      const cells: Record<string, string> = {
        name: info.hostname,
        model: r.model === ABSENT ? '' : r.model,
        role: info.role,
        mgmt: info.mgmt,
        serial: info.serial,
        where: r.where === ABSENT ? '' : r.where,
        ports: r.ports === ABSENT ? '' : r.ports,
        power: r.power === ABSENT ? '' : r.power,
        inlets: r.inletStates === ABSENT ? '' : r.inletStates,
        cables: r.cablesByKind === ABSENT ? '' : r.cablesByKind,
        lastChange: r.lastChangeMs != null ? formatLastChange(r.lastChangeMs) : '',
      };
      const { tags } = withExtras(doc, 'devices', ownerId, cells, defs);
      out.push({
        key: `${r.selection.kind}:${chassisId}`,
        selection: r.selection,
        ownerId,
        cells,
        tags,
        ids: { deviceId: info.deviceId, chassisId },
        title: info.hostname || (r.name === ABSENT ? 'unnamed' : r.name),
        deviceNodeId: info.deviceId,
      });
    }
  }
  return out;
}

export function rackRows(doc: Document, view: ClosetView, defs: readonly FieldDefView[] = []): InvRow[] {
  return view.racks.map((rack) => {
    const used = rack.chassis.reduce((n, c) => n + c.heightU, 0) + rack.shelves.reduce((n, s) => n + s.heightU, 0);
    const free = rack.freeRuns.reduce((n, r) => n + (r.toU - r.fromU + 1), 0);
    const cells: Record<string, string> = {
      name: rack.label,
      height: String(rack.heightU),
      row: rack.row ?? '',
      bay: rack.bay != null ? String(rack.bay) : '',
      used: `${used} of ${rack.heightU}U`,
      devices: String(rack.chassis.length),
      free: `${free}U`,
    };
    const { tags } = withExtras(doc, 'racks', rack.id, cells, defs);
    return {
      nums: { used, free, devices: rack.chassis.length, height: rack.heightU, ...(rack.bay != null ? { bay: rack.bay } : {}) },
      key: `rack:${rack.id}`,
      selection: { kind: 'rack', id: rack.id },
      ownerId: rack.id,
      cells,
      tags,
      ids: { rackId: rack.id },
      title: rack.label,
    };
  });
}

export function cableRows(doc: Document, view: ClosetView, endText: (end: CableEnd) => string, defs: readonly FieldDefView[] = []): InvRow[] {
  return view.cables.map((cable) => {
    const cells: Record<string, string> = {
      name: cable.label ?? '',
      kind: cable.kind,
      media: cable.media || '',
      sheath: cable.sheath ?? '',
      length: cable.lengthM != null ? String(cable.lengthM) : '',
      ownership: cable.ownership ?? '',
      endA: cable.ends[0] ? endText(cable.ends[0]) : '',
      endB: cable.ends[1] ? endText(cable.ends[1]) : '',
    };
    const { tags } = withExtras(doc, 'cables', cable.id, cells, defs);
    return {
      key: `cable:${cable.id}`,
      selection: { kind: 'cable', id: cable.id },
      ownerId: cable.id,
      cells,
      tags,
      ids: { cableId: cable.id },
      title: cable.label || `${cells.endA || ABSENT} to ${cells.endB || ABSENT}`,
    };
  });
}

export function portRows(doc: Document, view: ClosetView, endText: (end: CableEnd) => string, defs: readonly FieldDefView[] = []): InvRow[] {
  const out: InvRow[] = [];
  const cableById = new Map(view.cables.map((c) => [c.id, c]));
  const push = (port: ClosetView['racks'][number]['chassis'][number]['ports'][number], device: string) => {
    let cableTo = '';
    if (port.cable) {
      const cable = cableById.get(port.cable.cableId);
      const far = cable?.ends.find((e) => !('portId' in e) || e.portId !== port.id);
      cableTo = far ? endText(far) : '';
    }
    const cells: Record<string, string> = {
      name: port.label,
      device,
      connector: port.connector,
      service: '',
      face: port.face,
      uplink: port.uplink ? 'yes' : 'no',
      cable: cableTo,
    };
    const { tags } = withExtras(doc, 'ports', port.id, cells, defs);
    out.push({
      key: `port:${port.id}`,
      selection: { kind: 'port', id: port.id },
      ownerId: port.id,
      cells,
      tags,
      ids: {},
      title: `${device} · ${port.label}`,
    });
  };
  for (const row of view.rows) {
    for (const rack of row.racks) {
      for (const c of rack.chassis) for (const p of c.ports) push(p, c.hostname || 'unnamed');
      for (const shelf of rack.shelves) for (const o of shelf.occupants) for (const p of o.ports) push(p, o.label);
    }
  }
  const walk = (fixtures: ClosetView['surfaces'][number]['fixtures']) => {
    for (const f of fixtures) {
      for (const p of f.ports) push(p, f.label);
      walk(f.fixtures);
    }
  };
  for (const s of view.surfaces) walk(s.fixtures);
  return out;
}

export function addressRows(doc: Document, subnets: readonly SubnetRow[], deviceLabel: (deviceNodeId: string) => string): InvRow[] {
  const out: InvRow[] = [];
  for (const subnet of subnets) {
    for (const m of subnet.members) {
      out.push({
        key: `address:${m.addressNodeId}`,
        selection: null,
        ownerId: null,
        cells: { address: m.address, interface: m.interfaceLabel, device: deviceLabel(m.deviceId), subnet: subnet.prefix },
        tags: [],
        ids: {},
        title: m.address,
        deviceNodeId: m.deviceId,
      });
    }
  }
  void doc;
  return out;
}

/** Prefix rows: derived from the addresses on devices, read-only here (typing writes to a device). */
export function prefixRows(rows: readonly PrefixRow[]): InvRow[] {
  return rows.map((p) => ({
    key: p.key,
    selection: null,
    ownerId: null,
    cells: {
      prefix: p.prefix,
      vlan: p.vlan ? vlanLabel(p.vlan) : '',
      site: p.sites.join(', '),
      used: p.readable ? `${p.used}/${p.total}` : 'IPv6, not read',
      gateway: p.gateway ? `${p.gateway.address} ${p.gateway.deviceName}` : '',
    },
    tags: [],
    ids: {},
    title: p.prefix,
    sort: { prefix: p.range ? p.range.base * 33 + p.range.len : Number.MAX_SAFE_INTEGER, used: p.readable && p.total > 0 ? p.used / p.total : -1 },
    meter: p.readable && p.total > 0 ? { used: p.used / p.total } : undefined,
  }));
}

export function vlanKindRows(rows: readonly VlanKindRow[]): InvRow[] {
  return rows.map((v) => ({
    key: v.key,
    selection: null,
    ownerId: null,
    cells: {
      vlan: String(v.vlanId),
      label: v.name ?? '',
      prefixes: v.prefixes.join(', '),
      site: v.sites.join(', '),
      devices: v.deviceNames.join(', '),
      members: String(v.members.length),
    },
    tags: [],
    ids: {},
    title: v.name ? `VLAN ${v.vlanId} · ${v.name}` : `VLAN ${v.vlanId}`,
    sort: { vlan: v.vlanId, members: v.members.length },
  }));
}

// ---------------------------------------------------------------------------
// Edits

export class CellRefusal extends Error {}

export interface EditContext {
  catalogue: readonly CatalogueModel[];
  actor?: string;
  defs: readonly FieldDefView[];
}

export interface CellEdit {
  row: InvRow;
  col: Column;
  value: string;
}

function coreChange(kind: Kind, row: InvRow, colKey: string, value: string): import('../drawing/contract').EditorChange {
  const v = value.trim() === '' ? null : value.trim();
  const refuse = (): never => {
    throw new CellRefusal('That column cannot be edited here.');
  };
  if (kind === 'devices') {
    const deviceId = row.ids.deviceId;
    if (!deviceId) return refuse();
    if (colKey === 'name') return { kind: 'device', id: deviceId, field: 'hostname', value: v };
    if (colKey === 'role') return { kind: 'device', id: deviceId, field: 'role', value: v };
    if (colKey === 'mgmt') return { kind: 'device', id: deviceId, field: 'management_address', value: v };
    if (colKey === 'serial' && row.ids.chassisId) return { kind: 'chassis', id: row.ids.chassisId, field: 'serial', value: v };
  } else if (kind === 'racks' && row.ids.rackId) {
    if (colKey === 'name') return { kind: 'rack', id: row.ids.rackId, field: 'label', value: v };
    if (colKey === 'row') return { kind: 'rack', id: row.ids.rackId, field: 'row', value: v };
    if (colKey === 'bay') return { kind: 'rack', id: row.ids.rackId, field: 'bay', value: v };
    if (colKey === 'height') {
      const n = Number(v);
      if (v === null || !Number.isInteger(n)) throw new CellRefusal('A rack height must be a whole number of units.');
      return { kind: 'rack-height', id: row.ids.rackId, heightU: n };
    }
  } else if (kind === 'cables' && row.ids.cableId) {
    const field = colKey === 'name' ? 'label' : colKey === 'sheath' ? 'sheath' : colKey === 'length' ? 'length_m' : colKey === 'ownership' ? 'ownership' : null;
    if (field) return { kind: 'cable', id: row.ids.cableId, field, value: v };
  }
  return refuse();
}

function tagNames(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(',')) {
    const name = raw.trim().replace(/\s+/g, ' ');
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push(name);
    }
  }
  return out;
}

/**
 * Applies edits one after another to a working document. Custom-field edits are collected into one
 * batch. A refused edit is skipped and named; nothing it would have written is written.
 */
export function applyCellEdits(
  doc: Document,
  kind: Kind,
  edits: readonly CellEdit[],
  ctx: EditContext,
): { doc: Document; refused: string[]; changed: number } {
  const opts = ctx.actor ? { actor: ctx.actor } : undefined;
  let working = doc;
  const refused: string[] = [];
  const fieldSets: FieldSet[] = [];
  let changed = 0;
  const say = (row: InvRow, col: Column, e: unknown) =>
    refused.push(`${row.title || 'row'} · ${col.label}: ${e instanceof Error ? e.message : 'refused'}`);

  for (const { row, col, value } of edits) {
    try {
      if (col.type === 'tags') {
        if (!row.ownerId) throw new CellRefusal('This row takes no tags.');
        const want = tagNames(value);
        const have = tagsOf(working, row.ownerId);
        const wantKeys = new Set(want.map((w) => w.toLowerCase()));
        for (const chip of have) {
          if (!wantKeys.has(chip.name.toLowerCase())) working = untagObject(working, row.ownerId, chip.tagId, opts);
        }
        const haveKeys = new Set(have.map((h) => h.name.toLowerCase()));
        for (const name of want) if (!haveKeys.has(name.toLowerCase())) working = tagObject(working, row.ownerId, name, opts);
        changed += 1;
      } else if (col.defId) {
        if (!row.ownerId) throw new CellRefusal('This row takes no fields.');
        fieldSets.push({ ownerId: row.ownerId, defId: col.defId, raw: value });
        changed += 1;
      } else {
        working = applyEditorChange(working, coreChange(kind, row, col.key, value), ctx.catalogue, opts).doc;
        changed += 1;
      }
    } catch (e) {
      say(row, col, e);
    }
  }
  if (fieldSets.length > 0) {
    // Validate each separately so one bad value does not sink the rest.
    const good: FieldSet[] = [];
    for (const s of fieldSets) {
      try {
        setFieldValues(working, [s], ctx.defs, opts);
        good.push(s);
      } catch (e) {
        const edit = edits.find((x) => x.row.ownerId === s.ownerId && x.col.defId === s.defId);
        if (edit) say(edit.row, edit.col, e);
        changed -= 1;
      }
    }
    if (good.length > 0) working = setFieldValues(working, good, ctx.defs, opts);
  }
  return { doc: working, refused, changed };
}

export function kindOfNode(id: string): string {
  return parseNodeId(id).kind;
}

export { whereText };

// ---------------------------------------------------------------------------
// Adding by name

/** Kinds a row can be added to by name alone; cables are drawn and interfaces come with devices. */
export const CAN_ADD: ReadonlySet<Kind> = new Set<Kind>(['devices', 'racks']);

/** Adds a device (unplaced, no ports yet) or a rack with only a name. Throws on a refused name. */
export function addThing(
  doc: Document,
  kind: Kind,
  name: string,
  premisesId: string | null,
  ctx: EditContext,
): { doc: Document; row: InvRow } {
  const opts = ctx.actor ? { actor: ctx.actor } : undefined;
  const clean = name.trim();
  if (clean === '') throw new CellRefusal('Give it a name.');
  const before = new Set(doc.nodes.map((n) => n.id));
  if (kind === 'devices') {
    const next = createSketchDevice(doc, { hostname: clean, ...opts });
    const added = next.nodes.filter((n) => !before.has(n.id));
    const deviceId = added.find((n) => parseNodeId(n.id).kind === 'Device')?.id ?? '';
    const chassisId = added.find((n) => parseNodeId(n.id).kind === 'Chassis')?.id ?? '';
    return {
      doc: next,
      row: {
        key: `chassis:${chassisId}`,
        selection: { kind: 'chassis', id: chassisId },
        ownerId: deviceId,
        cells: { name: clean },
        tags: [],
        ids: { deviceId, chassisId },
        title: clean,
        deviceNodeId: deviceId,
      },
    };
  }
  if (kind === 'racks') {
    const made = addRack(doc, premisesId, { label: clean, heightU: 42, ...opts });
    return {
      doc: made.doc,
      row: {
        key: `rack:${made.rackId}`,
        selection: { kind: 'rack', id: made.rackId },
        ownerId: made.rackId,
        cells: { name: clean },
        tags: [],
        ids: { rackId: made.rackId },
        title: clean,
      },
    };
  }
  throw new CellRefusal('This kind is not added by name.');
}

export interface HistoryLine {
  label: string;
  who: string;
  when: number;
}

/** Batches that touched any of `ids`, newest first. */
export function historyOf(doc: Document, ids: readonly string[], limit = 100): HistoryLine[] {
  const want = new Set(ids);
  const prov = new Map(doc.provenance.map((p) => [p.id, p]));
  const out: HistoryLine[] = [];
  for (let i = doc.batches.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const b = doc.batches[i]!;
    let hit = false;
    let who = '';
    let when = 0;
    for (const op of b.ops) {
      const touched =
        op.type === 'add_node' ? [op.node] : op.type === 'add_edge' ? [op.from, op.to] : [op.element];
      if (!touched.some((t) => want.has(t))) continue;
      hit = true;
      if (op.type === 'tombstone' || op.type === 'revive') {
        who = op.by;
        when = op.at;
      } else {
        const rec = prov.get(op.prov);
        who = rec?.assertedBy ?? '';
        when = rec?.assertedAt ?? 0;
      }
      break;
    }
    if (hit) out.push({ label: b.label, who, when });
  }
  return out;
}
