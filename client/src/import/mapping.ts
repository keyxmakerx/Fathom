// Step 2: which Fathom field each column fills. Unknown columns become shared fields (ADR-0062):
// text, number, date or link, inferred from the values. Nothing here touches the document.

import { normalizeFieldValue, type FieldDefView } from '../document/fields';
import type { GatedTable, SourceKind } from './table';
import { normKey } from './text';

export const CORE_KEYS = ['name', 'model', 'vendor', 'serial', 'role', 'mgmt', 'rack', 'unit', 'face', 'tags', 'notes'] as const;
export type CoreKey = (typeof CORE_KEYS)[number];

export const CORE_LABEL: Record<CoreKey, string> = {
  name: 'Name',
  model: 'Model · matched in catalogue',
  vendor: 'Maker · helps match the model',
  serial: 'Serial',
  role: 'Role',
  mgmt: 'Management address',
  rack: 'Rack',
  unit: 'Rack unit',
  face: 'Rack face',
  tags: 'Tags',
  notes: 'Notes',
};

/** Targets that take only one column; tags and notes take several. */
const SINGLE: ReadonlySet<CoreKey> = new Set(['name', 'model', 'vendor', 'serial', 'role', 'mgmt', 'rack', 'unit', 'face']);

export type NewFieldType = 'text' | 'number' | 'date' | 'url';
export const NEW_FIELD_TYPES: readonly NewFieldType[] = ['text', 'number', 'date', 'url'];

export type Target =
  | { kind: 'ignore' }
  | { kind: 'core'; key: CoreKey }
  | { kind: 'field'; defId: string }
  | { kind: 'new'; name: string; type: NewFieldType };

export type Mapping = Target[];

// Header spellings, best first. Dotted NetBox JSON paths are normalised the same way.
const ALIASES: Record<CoreKey, readonly string[]> = {
  name: ['name', 'hostname', 'host_name', 'device_name', 'device', 'label'],
  model: ['device_type_model', 'device_type', 'model', 'type'],
  vendor: ['device_type_manufacturer_name', 'manufacturer', 'vendor', 'make'],
  serial: ['serial', 'serial_number', 'serial_no', 'serial_nr'],
  role: ['role', 'role_name', 'device_role', 'device_role_name'],
  mgmt: ['primary_ip4_address', 'primary_ip4', 'primary_ip', 'primary_ip_address', 'management_address', 'mgmt', 'management_ip', 'ip', 'ip_address', 'address'],
  rack: ['rack_name', 'rack'],
  unit: ['position', 'rack_unit', 'unit', 'u'],
  face: ['face', 'rack_face'],
  tags: ['tags', 'tag', 'labels'],
  notes: ['comments', 'description', 'notes', 'note', 'scan_output'],
};

const FIELD_NAME_FIX: Record<string, string> = { os: 'OS', ip: 'IP', mac: 'MAC address', vmid: 'VM ID', ostype: 'OS type' };

/** "cf_owner" and "custom_fields.owner" read "Owner"; "device_type.model" reads "Device type model". */
export function fieldNameFor(header: string): string {
  const key = normKey(header).replace(/^(cf|custom_fields)_/, '').replace(/(.)_(name|value|address)$/, '$1');
  if (FIELD_NAME_FIX[key]) return FIELD_NAME_FIX[key]!;
  const words = key.replace(/_/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : header.trim() || 'Imported';
}

/** The narrowest of number, date, link that every value fits; else text. */
export function inferType(values: readonly string[]): NewFieldType {
  const filled = values.filter((v) => v.trim() !== '');
  if (filled.length === 0) return 'text';
  for (const type of ['number', 'date', 'url'] as const) {
    if (filled.every((v) => { try { return normalizeFieldValue({ type, choices: [] }, v) !== null; } catch { return false; } })) return type;
  }
  return 'text';
}

const PROXMOX_KEEP = new Set(['vmid', 'type', 'node', 'status', 'cores', 'memory', 'ostype', 'template', 'mac']);
const CUSTOM = /^(cf|custom_fields)_/;

export function sampleOf(table: GatedTable, col: number): string {
  for (const r of table.rows) if ((r[col] ?? '') !== '') return r[col]!;
  return '';
}

function keepUnknown(kind: SourceKind, header: string): boolean {
  const key = normKey(header);
  if (kind === 'proxmox') return PROXMOX_KEEP.has(key) || key === 'ip';
  if (kind === 'netbox-json' || kind === 'json') return !header.includes('.') || CUSTOM.test(key) || /\.(name|address|value)$/.test(header);
  return true;
}

export function defaultMapping(table: GatedTable, defs: readonly FieldDefView[]): Mapping {
  const keys = table.headers.map(normKey);
  const mapping: Mapping = table.headers.map(() => ({ kind: 'ignore' }));
  const taken = new Set<number>();
  for (const core of CORE_KEYS) {
    const aliases = core === 'model' && !table.kind.startsWith('netbox') ? ALIASES.model.filter((a) => a !== 'type') : ALIASES[core];
    const hits = SINGLE.has(core) ? [] : keys.map((k, i) => (aliases.includes(k) ? i : -1)).filter((i) => i >= 0);
    if (SINGLE.has(core)) {
      let best = -1;
      let rank = Infinity;
      keys.forEach((k, i) => {
        const r = aliases.indexOf(k);
        if (r >= 0 && r < rank && !taken.has(i)) {
          best = i;
          rank = r;
        }
      });
      if (best >= 0) hits.push(best);
    }
    for (const i of hits) {
      if (taken.has(i)) continue;
      taken.add(i);
      mapping[i] = { kind: 'core', key: core };
    }
  }
  const live = defs.filter((d) => d.appliesTo === 'device' && !d.archived);
  const usedNames = new Set<string>();
  table.headers.forEach((h, i) => {
    if (taken.has(i)) return;
    const filled = table.rows.some((r) => (r[i] ?? '') !== '');
    if (!filled || !keepUnknown(table.kind, h)) return;
    const name = fieldNameFor(h);
    const existing = live.find((d) => normKey(d.name) === normKey(name));
    if (existing) {
      mapping[i] = { kind: 'field', defId: existing.id };
      return;
    }
    let unique = name;
    for (let n = 2; usedNames.has(unique.toLowerCase()); n += 1) unique = `${name} ${n}`;
    usedNames.add(unique.toLowerCase());
    mapping[i] = { kind: 'new', name: unique, type: inferType(table.rows.map((r) => r[i] ?? '')) };
  });
  return mapping;
}

/** What stops the person going on; empty when the mapping can be planned. */
export function mappingErrors(table: GatedTable, mapping: Mapping, defs: readonly FieldDefView[]): string[] {
  const errors: string[] = [];
  const count = (pred: (t: Target) => boolean) => mapping.filter(pred).length;
  if (count((t) => t.kind === 'core' && t.key === 'name') !== 1) errors.push('Exactly one column must be the Name.');
  for (const key of SINGLE) {
    if (key !== 'name' && count((t) => t.kind === 'core' && t.key === key) > 1) errors.push(`More than one column is set to ${CORE_LABEL[key]}.`);
  }
  const seenField = new Set<string>();
  const newNames = new Set<string>();
  const live = new Map(defs.filter((d) => !d.archived).map((d) => [d.id, d]));
  mapping.forEach((t, i) => {
    if (t.kind === 'field') {
      if (!live.has(t.defId)) errors.push(`"${table.headers[i]}" points to a field that no longer exists.`);
      if (seenField.has(t.defId)) errors.push(`Two columns fill the field "${live.get(t.defId)?.name ?? ''}".`);
      seenField.add(t.defId);
    }
    if (t.kind === 'new') {
      const name = t.name.trim().replace(/\s+/g, ' ');
      if (name === '') errors.push(`Give the new field for "${table.headers[i]}" a name.`);
      else if (Array.from(name).length > 100) errors.push(`The field name "${name.slice(0, 20)}…" is over 100 characters.`);
      const key = name.toLowerCase();
      if (newNames.has(key)) errors.push(`Two new fields are called "${name}".`);
      newNames.add(key);
      if ([...live.values()].some((d) => d.appliesTo === 'device' && d.name.toLowerCase() === key)) {
        errors.push(`A shared field "${name}" already exists. Pick it from the list instead.`);
      }
    }
  });
  return errors;
}
