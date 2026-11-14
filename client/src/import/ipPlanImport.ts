// NetBox files into the IP plan (ADR-0083 decision 6). Pure: reads tables the redaction gate has
// already passed (`gateTable`, CLAUDE.md rule 4), says which NetBox list each one is, and compares
// every row with the plan as New, Match or Differ. Nothing is stored here: `applyPlanImport` makes
// the records through the store's own create and update, so the server checks every value and
// every right exactly as it does for the IP plan page.
//
// The columns read are NetBox's import columns (the ones Download for NetBox writes, checked
// against NetBox 4.7.5's import forms), and the same names as a NetBox table export heads them
// ("Start address", "Is pool"), spaces and case aside.

import type { PlanFields, PlanKind, PlanRecord } from '../api/ipPlan';
import { flag, parseCidrBig, parseRangeBig, spanContains, text } from '../components/organisation/ipPlanModel';
import type { GatedTable } from './table';

/** The NetBox lists read, in the order they are made, so each finds what it names. */
export const IMPORT_ORDER = ['vrf', 'aggregate', 'vlan_group', 'vlan', 'prefix', 'range', 'address', 'asn_range', 'asn'] as const satisfies readonly PlanKind[];
export type ImportKind = (typeof IMPORT_ORDER)[number];

const NETBOX_WORDS: Record<ImportKind, string> = {
  vrf: 'VRFs',
  aggregate: 'Aggregates',
  vlan_group: 'VLAN groups',
  vlan: 'VLANs',
  prefix: 'Prefixes',
  range: 'IP ranges',
  address: 'IP addresses',
  asn_range: 'ASN ranges',
  asn: 'ASNs',
};

export type RowState = 'new' | 'match' | 'differ' | 'skip';

export interface ImportRow {
  kind: ImportKind;
  /** What the row is, as a person reads it: 10.20.0.0/16, VLAN 120 in Campus. */
  label: string;
  state: RowState;
  /** For Differ, what is different; for a skipped row, why. */
  says: string;
  /** The record's fields, with VRFs, groups and ranges still named, not yet ids. */
  fields: PlanFields;
  /** The names this row points at: VRF, VLAN group. */
  refs: { vrf?: string; group?: string };
  /** The record it matches or differs from. */
  existing: PlanRecord | null;
}

export interface ImportFile {
  label: string;
  kind: ImportKind | null;
  rows: ImportRow[];
}

/** "Start address" and "start_address" are one column. */
const norm = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, '_');

const ALIASES: Record<string, string> = {
  mark_utilised: 'mark_utilized',
  marked_utilized: 'mark_utilized',
  utilized: 'mark_utilized',
  pool: 'is_pool',
  populated: 'mark_populated',
  marked_populated: 'mark_populated',
  route_distinguisher: 'rd',
  vlan_id: 'vid',
  dns: 'dns_name',
};

/** Which NetBox list a table is, by its columns. */
export function kindOf(headers: readonly string[]): ImportKind | null {
  const h = new Set(headers.map(norm).map((x) => ALIASES[x] ?? x));
  if (h.has('start_address') && h.has('end_address')) return 'range';
  if (h.has('address')) return 'address';
  if (h.has('prefix')) return h.has('rir') && !h.has('status') ? 'aggregate' : 'prefix';
  if (h.has('asn')) return 'asn';
  if (h.has('name') && h.has('start') && h.has('end')) return 'asn_range';
  if (h.has('vid')) return 'vlan';
  if (h.has('name') && (h.has('vid_ranges') || (h.has('slug') && !h.has('rd')))) return 'vlan_group';
  if (h.has('name') && (h.has('rd') || h.has('enforce_unique'))) return 'vrf';
  return null;
}

const YES = new Set(['true', 'yes', 'y', '1', '✓', '✔', 'x']);
const bool = (v: string) => YES.has(v.trim().toLowerCase());
/** NetBox exports a choice as its label ("Active", "DHCP"); the store keeps its value. */
const choice = (v: string) => v.trim().toLowerCase();

const PREFIX_STATUS = new Set(['container', 'active', 'reserved', 'deprecated']);
const STATUS = new Set(['active', 'reserved', 'deprecated']);
const ADDRESS_STATUS = new Set(['active', 'reserved', 'deprecated', 'dhcp', 'slaac']);
const ADDRESS_ROLE = new Set(['loopback', 'secondary', 'anycast', 'vip', 'vrrp', 'hsrp', 'glbp', 'carp']);

/** A row read into store fields, or why it cannot be. */
type Read = { fields: Record<string, string | boolean | string[]>; refs: ImportRow['refs']; label: string } | { skip: string; label: string };

function readRow(kind: ImportKind, cell: (name: string) => string): Read {
  const note = cell('description');
  const withNote = (f: Record<string, string | boolean | string[]>) => {
    if (note) f.note = note;
    return f;
  };
  const vrf = cell('vrf');
  const refs = vrf && !/^(global|global table|none)$/i.test(vrf) ? { vrf } : {};
  switch (kind) {
    case 'vrf': {
      const name = cell('name');
      if (!name) return { skip: 'it has no name', label: 'A VRF' };
      const f: Record<string, string | boolean | string[]> = { name, enforce_unique: bool(cell('enforce_unique')) };
      if (cell('rd')) f.route_distinguisher = cell('rd');
      return { fields: withNote(f), refs: {}, label: `VRF ${name}` };
    }
    case 'aggregate': {
      const prefix = cell('prefix');
      if (!parseCidrBig(prefix)) return { skip: 'its prefix is not a network', label: prefix || 'An aggregate' };
      const f: Record<string, string | boolean | string[]> = { prefix };
      if (cell('rir')) f.rir = cell('rir');
      return { fields: withNote(f), refs: {}, label: prefix };
    }
    case 'prefix': {
      const prefix = cell('prefix');
      if (!parseCidrBig(prefix)) return { skip: 'its prefix is not a network', label: prefix || 'A prefix' };
      const status = choice(cell('status')) || 'active';
      if (!PREFIX_STATUS.has(status)) return { skip: `NetBox's status "${cell('status')}" has no match here`, label: prefix };
      const f: Record<string, string | boolean | string[]> = { prefix, status, is_pool: bool(cell('is_pool')), mark_utilised: bool(cell('mark_utilized')) };
      if (cell('role')) f.role = cell('role');
      return { fields: withNote(f), refs, label: prefix };
    }
    case 'range': {
      const range = `${cell('start_address').split('/')[0]}-${cell('end_address').split('/')[0]}`;
      if (!parseRangeBig(range)) return { skip: 'its start and end are not a range', label: range };
      const status = choice(cell('status')) || 'active';
      if (!STATUS.has(status)) return { skip: `NetBox's status "${cell('status')}" has no match here`, label: range };
      const f: Record<string, string | boolean | string[]> = { range, status, populated: bool(cell('mark_populated')), mark_utilised: bool(cell('mark_utilized')) };
      if (cell('role')) f.role = cell('role');
      return { fields: withNote(f), refs, label: range };
    }
    case 'address': {
      const address = cell('address');
      if (!parseCidrBig(address, true)) return { skip: 'it is not an address', label: address || 'An address' };
      const status = choice(cell('status')) || 'active';
      if (!ADDRESS_STATUS.has(status)) return { skip: `NetBox's status "${cell('status')}" has no match here`, label: address };
      const f: Record<string, string | boolean | string[]> = { address, status };
      const role = choice(cell('role'));
      if (role && ADDRESS_ROLE.has(role)) f.role = role;
      if (cell('dns_name')) f.dns_name = cell('dns_name');
      return { fields: withNote(f), refs, label: address };
    }
    case 'vlan_group': {
      const name = cell('name');
      if (!name) return { skip: 'it has no name', label: 'A VLAN group' };
      const ranges = (cell('vid_ranges') || '1-4094')
        .split(',')
        .map((r) => r.trim())
        .filter((r) => r !== '');
      return { fields: withNote({ name, vid_ranges: ranges }), refs: {}, label: `VLAN group ${name}` };
    }
    case 'vlan': {
      const vid = cell('vid');
      const name = cell('name');
      const group = cell('group');
      if (!/^\d+$/.test(vid) || !name) return { skip: 'it needs a VLAN ID and a name', label: `VLAN ${vid}` };
      if (!group) return { skip: 'the plan keeps every VLAN in a group, and this one names none', label: `VLAN ${vid} ${name}` };
      const status = choice(cell('status')) || 'active';
      if (!STATUS.has(status)) return { skip: `NetBox's status "${cell('status')}" has no match here`, label: `VLAN ${vid}` };
      return { fields: withNote({ vid, name, status }), refs: { group }, label: `VLAN ${vid} ${name} in ${group}` };
    }
    case 'asn_range': {
      const name = cell('name');
      const first = cell('start');
      const last = cell('end');
      if (!name || !/^\d+$/.test(first) || !/^\d+$/.test(last)) return { skip: 'it needs a name, a start and an end', label: name || 'An ASN range' };
      const f: Record<string, string | boolean | string[]> = { name, first, last };
      if (cell('rir')) f.rir = cell('rir');
      return { fields: withNote(f), refs: {}, label: `${name} (${first} to ${last})` };
    }
    case 'asn': {
      const asn = cell('asn').replace(/^AS/i, '');
      if (!/^\d+$/.test(asn)) return { skip: 'it is not an AS number', label: cell('asn') || 'An ASN' };
      return { fields: withNote({ asn }), refs: {}, label: `AS ${asn}` };
    }
  }
}

const vrfName = (records: readonly PlanRecord[], id: string | null) => (id ? (text(records.find((r) => r.id === id)?.fields ?? {}, 'name') ?? '') : '');

/** What makes a row the same thing as a record: its value and, where it has one, its VRF or group. */
function identity(kind: ImportKind, fields: PlanFields, refs: ImportRow['refs']): string {
  const t = (n: string) => (text(fields, n) ?? '').toLowerCase();
  const v = (refs.vrf ?? '').toLowerCase();
  switch (kind) {
    case 'vrf':
    case 'vlan_group':
    case 'asn_range':
      return t('name');
    case 'aggregate':
      return t('prefix');
    case 'prefix':
      return `${v}|${t('prefix')}`;
    case 'range':
      return `${v}|${t('range')}`;
    case 'address':
      return `${v}|${t('address')}`;
    case 'vlan':
      return `${(refs.group ?? '').toLowerCase()}|${t('vid')}`;
    case 'asn':
      return t('asn');
  }
}

function identityOf(r: PlanRecord, records: readonly PlanRecord[]): string {
  const kind = r.kind as ImportKind;
  const refs: ImportRow['refs'] = {};
  if (kind === 'prefix' || kind === 'range' || kind === 'address') refs.vrf = vrfName(records, text(r.fields, 'vrf'));
  if (kind === 'vlan') refs.group = vrfName(records, text(r.fields, 'group'));
  return identity(kind, r.fields, refs);
}

/** The fields a row and its record disagree on, in words. VRFs and groups are part of what it is. */
function differences(fields: PlanFields, existing: PlanRecord): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    const was = existing.fields[k];
    const same = Array.isArray(v) ? Array.isArray(was) && v.join(',') === was.join(',') : typeof v === 'boolean' ? flag(existing.fields, k) === v : (text(existing.fields, k) ?? '') === v;
    if (!same) out.push(k === 'note' ? 'its description' : k.replace(/_/g, ' '));
  }
  return out;
}

/** Each gated table as a NetBox list, every row New, Match, Differ or skipped against the plan. */
export function planImport(tables: readonly GatedTable[], records: readonly PlanRecord[]): ImportFile[] {
  const known = new Map<string, PlanRecord>();
  for (const r of records) if ((IMPORT_ORDER as readonly string[]).includes(r.kind)) known.set(`${r.kind}|${identityOf(r, records)}`, r);
  const seen = new Set<string>();
  return tables.map((table) => {
    const kind = kindOf(table.headers);
    if (kind === null) return { label: table.label, kind: null, rows: [] };
    const index = new Map<string, number>();
    table.headers.forEach((h, i) => {
      const n = norm(h);
      const key = ALIASES[n] ?? n;
      if (!index.has(key)) index.set(key, i);
    });
    const rows = table.rows.map((row): ImportRow => {
      const cell = (name: string) => (row[index.get(name) ?? -1] ?? '').trim();
      const read = readRow(kind, cell);
      if ('skip' in read) return { kind, label: read.label, state: 'skip', says: `Not read: ${read.skip}.`, fields: {}, refs: {}, existing: null };
      const id = `${kind}|${identity(kind, read.fields, read.refs)}`;
      if (seen.has(id)) return { kind, label: read.label, state: 'skip', says: 'Not read: it is in the files twice.', fields: read.fields, refs: read.refs, existing: null };
      seen.add(id);
      const existing = known.get(id) ?? null;
      if (!existing) return { kind, label: read.label, state: 'new', says: '', fields: read.fields, refs: read.refs, existing: null };
      const diff = differences(read.fields, existing);
      return diff.length === 0
        ? { kind, label: read.label, state: 'match', says: '', fields: read.fields, refs: read.refs, existing }
        : { kind, label: read.label, state: 'differ', says: `The file has a different ${diff.join(', ')}.`, fields: read.fields, refs: read.refs, existing };
    });
    return { label: `${NETBOX_WORDS[kind]}, ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`, kind, rows };
  });
}

export function importCounts(files: readonly ImportFile[]): Record<RowState, number> {
  const out: Record<RowState, number> = { new: 0, match: 0, differ: 0, skip: 0 };
  for (const f of files) for (const r of f.rows) out[r.state] += 1;
  return out;
}

export interface PlanWriter {
  create: (kind: PlanKind, fields: PlanFields) => Promise<PlanRecord>;
  update: (record: PlanRecord, fields: PlanFields) => Promise<PlanRecord>;
}

export interface ApplyResult {
  made: number;
  changed: number;
  /** Each row the store refused, with its sentence. */
  refused: Array<{ label: string; why: string }>;
}

/**
 * Make the New rows, and change the Differ rows when `alsoChange`, in `IMPORT_ORDER`, naming VRFs,
 * groups and ranges by the ids they have in the plan or were just given. A row the store refuses
 * is reported and the rest go on.
 */
export async function applyPlanImport(files: readonly ImportFile[], records: readonly PlanRecord[], writer: PlanWriter, alsoChange: boolean, why: (e: unknown) => string): Promise<ApplyResult> {
  const all = [...records];
  const byName = (kind: PlanKind, name: string) => all.find((r) => r.kind === kind && (text(r.fields, 'name') ?? '').toLowerCase() === name.toLowerCase());
  const result: ApplyResult = { made: 0, changed: 0, refused: [] };
  const rows = files.flatMap((f) => f.rows).filter((r) => r.state === 'new' || (alsoChange && r.state === 'differ'));
  for (const kind of IMPORT_ORDER) {
    for (const row of rows.filter((r) => r.kind === kind)) {
      const fields: Record<string, string | boolean | readonly string[]> = { ...row.fields };
      if (row.refs.vrf) {
        const vrf = byName('vrf', row.refs.vrf);
        if (!vrf) {
          result.refused.push({ label: row.label, why: `The plan has no VRF ${row.refs.vrf}; add it, or load VRFs first.` });
          continue;
        }
        fields.vrf = vrf.id;
      }
      if (row.refs.group) {
        const group = byName('vlan_group', row.refs.group);
        if (!group) {
          result.refused.push({ label: row.label, why: `The plan has no VLAN group ${row.refs.group}; load VLAN groups first.` });
          continue;
        }
        fields.group = group.id;
      }
      if (kind === 'asn' && typeof fields.asn === 'string') {
        const n = BigInt(fields.asn);
        const range = all.find((r) => r.kind === 'asn_range' && /^\d+$/.test(text(r.fields, 'first') ?? '') && /^\d+$/.test(text(r.fields, 'last') ?? '') && BigInt(text(r.fields, 'first')!) <= n && n <= BigInt(text(r.fields, 'last')!));
        if (range) fields.range = range.id;
      }
      try {
        if (row.state === 'differ' && row.existing) {
          const saved = await writer.update(row.existing, { ...row.existing.fields, ...fields });
          all.splice(all.indexOf(row.existing), 1, saved);
          result.changed += 1;
        } else {
          all.push(await writer.create(kind, fields));
          result.made += 1;
        }
      } catch (e) {
        result.refused.push({ label: row.label, why: why(e) });
      }
    }
  }
  return result;
}

/** Whether a prefix row sits inside one of the plan's aggregates, for a hint under the preview. */
export function outsideAggregates(files: readonly ImportFile[], records: readonly PlanRecord[]): number {
  const aggs = [...records.filter((r) => r.kind === 'aggregate').map((r) => text(r.fields, 'prefix') ?? ''), ...files.flatMap((f) => f.rows.filter((r) => r.kind === 'aggregate' && r.state !== 'skip').map((r) => text(r.fields, 'prefix') ?? ''))]
    .map((p) => parseCidrBig(p))
    .filter((s): s is NonNullable<typeof s> => s !== undefined);
  return files
    .flatMap((f) => f.rows)
    .filter((r) => r.kind === 'prefix' && r.state === 'new')
    .filter((r) => {
      const s = parseCidrBig(text(r.fields, 'prefix') ?? '');
      return s !== undefined && !aggs.some((a) => spanContains(a, s));
    }).length;
}
