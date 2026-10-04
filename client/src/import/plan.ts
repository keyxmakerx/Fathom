// Step 3: sort every row into New, Match, Differ or No model against the open design. Pure; the
// document is only read. Matching is by name (case-insensitive). A Match has the same name and no
// contradicting value: the file only fills blanks. A Differ has a value that disagrees with what
// is already there; the person picks per row, and the default keeps what is there.

import type { CatalogueModel } from '../api/catalogue';
import { isDeviceRole, isIpAddr, type DeviceRole } from '../document/edit';
import { normalizeFieldValue, type FieldDefView } from '../document/fields';
import { fieldValue } from '../document/fields';
import type { Document } from '../document/model';
import { notesOf } from '../document/notes';
import { tagsOf } from '../document/tags';
import { devicesByName, racksByLabel, type ExistingDevice } from './existing';
import { ImportRefusal, LIMITS } from './limits';
import { looksLikeSecret, type Mapping, type NewFieldType } from './mapping';
import type { GatedTable } from './table';
import { neutraliseElement, normKey, oneLine, toHostname, toSerial } from './text';

export type Bucket = 'new' | 'match' | 'differ' | 'nomodel' | 'skipped';

/** A shared field: an existing definition, or one this import creates (by index into `Plan.newFields`). */
export type FieldRef = { defId: string } | { fresh: number };

export interface FieldValueSet {
  ref: FieldRef;
  label: string;
  value: string;
}

export interface Diff {
  /** `serial`, `role`, `mgmt`, or `field:<n>` (index into the item's `fields`). */
  key: string;
  label: string;
  mine: string;
  theirs: string;
}

export interface PlanItem {
  /** Data row number in the file, from 1. */
  row: number;
  bucket: Bucket;
  name: string;
  /** Why it is a free box or skipped. */
  reason?: string;
  existing?: ExistingDevice;
  role?: DeviceRole;
  mgmt?: string;
  serial?: string;
  tags: string[];
  notes: string[];
  fields: FieldValueSet[];
  /** New and placeable only. */
  placement?: { rackId: string; unit: number; face: 'front' | 'rear'; model: CatalogueModel };
  /** Existing devices: values that disagree (Differ). */
  conflicts: Diff[];
  /** Existing devices: blanks the file fills. */
  fills: Diff[];
  /** Values dropped because the schema would refuse them. */
  warnings: string[];
}

export interface NewField {
  name: string;
  type: NewFieldType;
}

export interface Plan {
  items: PlanItem[];
  newFields: NewField[];
  counts: Record<Bucket, number>;
  warnings: number;
}

export interface PlanContext {
  doc: Document;
  catalogue: readonly CatalogueModel[];
  defs: readonly FieldDefView[];
}

const ROLE_WORDS: Array<[RegExp, DeviceRole]> = [
  [/firewall|\bfw\b/, 'firewall'],
  [/load.?balanc|\blb\b/, 'load_balancer'],
  [/access.?point|\bwap\b|\bap\b|wireless|wifi/, 'access_point'],
  [/router|gateway/, 'router'],
  [/switch/, 'switch'],
  [/server|hypervisor|\bhost\b|\bvm\b|virtual/, 'server'],
];

export function roleFor(raw: string): DeviceRole | null {
  const s = oneLine(raw).toLowerCase();
  if (s === '') return null;
  const snake = s.replace(/[\s-]+/g, '_');
  if (isDeviceRole(snake)) return snake;
  for (const [re, role] of ROLE_WORDS) if (re.test(s)) return role;
  return null;
}

/** "10.0.99.2/24" is the address 10.0.99.2; a mask is dropped. */
export function addressFor(raw: string): string | null {
  const s = oneLine(raw).replace(/\/\d{1,3}$/, '');
  return isIpAddr(s) ? s : null;
}

function splitTags(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw.split(/[,;\n]/)) {
    const name = neutraliseElement(oneLine(t));
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push(name);
    }
  }
  return out;
}

export function findModel(catalogue: readonly CatalogueModel[], model: string, vendor: string): CatalogueModel | 'ambiguous' | null {
  const m = normKey(model).replace(/_/g, '');
  if (m === '') return null;
  const v = normKey(vendor).replace(/_/g, '');
  const hits = catalogue.filter((c) => {
    const cm = normKey(c.model).replace(/_/g, '');
    const cv = normKey(c.vendor).replace(/_/g, '');
    return cm === m || cv + cm === m || (v !== '' && cm === m.replace(v, ''));
  });
  const sure = v === '' ? hits : hits.filter((c) => normKey(c.vendor).replace(/_/g, '') === v || m.startsWith(normKey(c.vendor).replace(/_/g, '')));
  const pool = sure.length > 0 ? sure : hits;
  if (pool.length === 0) return null;
  return pool.length === 1 ? pool[0]! : 'ambiguous';
}

/** Names the person's choice for a Differ row by the device and the fields in dispute, not the row number. */
export function choiceKey(item: PlanItem): string {
  return `${item.name.toLowerCase()}\u0000${item.conflicts.map((c) => c.key).sort().join(',')}`;
}

const conflictSig = (item: PlanItem) => JSON.stringify(item.conflicts.map((c) => [c.key, c.mine, c.theirs]));

/**
 * `finalPlan` was made after the person looked at `shown`. A Differ row whose conflicts are not the
 * ones they saw is turned into a skipped row (nothing is written for it) and reported.
 */
export function holdChangedConflicts(shown: Plan, finalPlan: Plan): string[] {
  const before = new Map(shown.items.filter((i) => i.bucket === 'differ').map((i) => [i.name.toLowerCase(), conflictSig(i)]));
  const held: string[] = [];
  for (const item of finalPlan.items) {
    if (item.bucket !== 'differ' || before.get(item.name.toLowerCase()) === conflictSig(item)) continue;
    item.bucket = 'skipped';
    item.reason = 'The design changed since you looked at this row.';
    finalPlan.counts.differ -= 1;
    finalPlan.counts.skipped += 1;
    held.push(`${item.name}: this device changed while you were importing, so it was left as it is.`);
  }
  return held;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function buildPlan(table: GatedTable, given: Mapping, ctx: PlanContext): Plan {
  // A column that looks like a secret is never read, whatever the mapping says.
  const mapping = given.map((t, i): Mapping[number] => (looksLikeSecret(table.headers[i] ?? '') ? { kind: 'ignore' } : t));
  const extra = table.headers.filter((_, i) => mapping[i]?.kind === 'new').slice(LIMITS.newFields);
  if (extra.length > 0) {
    throw new ImportRefusal(`At most ${LIMITS.newFields} new shared fields can be made in one import. Set these columns to Ignore or to an existing field: ${extra.map((h) => `"${h}"`).join(', ')}.`);
  }
  const cell = (r: string[], i: number) => (r[i] ?? '').trim();
  const col = (key: string) => mapping.findIndex((t) => t.kind === 'core' && t.key === key);
  const colsOf = (key: string) => mapping.flatMap((t, i) => (t.kind === 'core' && t.key === key ? [i] : []));
  const nameCol = col('name');
  const [modelCol, vendorCol, serialCol, roleCol, mgmtCol, rackCol, unitCol, faceCol] = ['model', 'vendor', 'serial', 'role', 'mgmt', 'rack', 'unit', 'face'].map(col);
  const tagCols = colsOf('tags');
  const noteCols = colsOf('notes');

  const newFields: NewField[] = [];
  const fieldCols: Array<{ col: number; ref: FieldRef; label: string; type: NewFieldType | FieldDefView }> = [];
  mapping.forEach((t, i) => {
    if (t.kind === 'field') {
      const def = ctx.defs.find((d) => d.id === t.defId && !d.archived);
      if (def) fieldCols.push({ col: i, ref: { defId: def.id }, label: def.name, type: def });
    } else if (t.kind === 'new') {
      newFields.push({ name: t.name.trim().replace(/\s+/g, ' '), type: t.type });
      fieldCols.push({ col: i, ref: { fresh: newFields.length - 1 }, label: t.name.trim(), type: t.type });
    }
  });

  const existing = devicesByName(ctx.doc);
  const racks = racksByLabel(ctx.doc);
  const seen = new Set<string>();
  const items: PlanItem[] = [];

  table.rows.forEach((r, n) => {
    const rawName = nameCol >= 0 ? cell(r, nameCol) : '';
    const item: PlanItem = { row: n + 1, bucket: 'new', name: rawName, tags: [], notes: [], fields: [], conflicts: [], fills: [], warnings: [] };
    items.push(item);
    const skip = (reason: string) => {
      item.bucket = 'skipped';
      item.reason = reason;
    };
    if (rawName === '') return skip('No name.');
    const host = toHostname(rawName);
    if (!host) return skip('The name has characters a hostname cannot hold (only printable ASCII; spaces become -).');
    item.name = host;
    if (seen.has(host.toLowerCase())) return skip('The same name appears earlier in the file.');
    seen.add(host.toLowerCase());

    const warn = (s: string) => item.warnings.push(s);
    if (roleCol >= 0 && cell(r, roleCol)) {
      const role = roleFor(cell(r, roleCol));
      if (role) item.role = role;
      else warn(`Role "${cell(r, roleCol).slice(0, 40)}" is not one Fathom has; left out.`);
    }
    if (mgmtCol >= 0 && cell(r, mgmtCol)) {
      const a = addressFor(cell(r, mgmtCol));
      if (a) item.mgmt = a;
      else warn(`Management address "${cell(r, mgmtCol).slice(0, 40)}" is not an IP address; left out.`);
    }
    if (serialCol >= 0 && cell(r, serialCol)) {
      const s = toSerial(cell(r, serialCol));
      if (s) item.serial = s;
      else warn('The serial has spaces or characters the schema does not take; left out.');
    }
    for (const c of tagCols) for (const t of splitTags(cell(r, c))) if (!item.tags.some((x) => x.toLowerCase() === t.toLowerCase())) item.tags.push(t);
    for (const c of noteCols) if (cell(r, c)) item.notes.push(cell(r, c));
    for (const f of fieldCols) {
      const raw = cell(r, f.col);
      if (raw === '') continue;
      const text = Array.from(raw).length > LIMITS.fieldChars ? Array.from(raw).slice(0, LIMITS.fieldChars).join('') : raw;
      try {
        const v = normalizeFieldValue(typeof f.type === 'string' ? { type: f.type, choices: [] } : f.type, text);
        if (v !== null) item.fields.push({ ref: f.ref, label: f.label, value: v });
      } catch (e) {
        warn(`${f.label}: ${e instanceof Error ? e.message : 'refused'}; left out.`);
      }
    }

    const found = existing.get(host.toLowerCase());
    if (found) {
      compareWithExisting(item, found, ctx);
      return;
    }

    // New: a device with a catalogue model and a free rack position is placed; anything else is a free box.
    const modelText = modelCol >= 0 ? cell(r, modelCol) : '';
    const vendorText = vendorCol >= 0 ? cell(r, vendorCol) : '';
    const model = modelText ? findModel(ctx.catalogue, modelText, vendorText) : null;
    const rackText = rackCol >= 0 ? cell(r, rackCol) : '';
    const rack = rackText ? racks.get(rackText.toLowerCase()) : undefined;
    const unitText = unitCol >= 0 ? cell(r, unitCol) : '';
    const unit = /^\d+(\.0+)?$/.test(unitText) ? Number.parseInt(unitText, 10) : NaN;
    const face = faceCol >= 0 && /^rear/i.test(cell(r, faceCol)) ? 'rear' : 'front';
    let why = '';
    if (!model) why = modelText ? `"${modelText.slice(0, 40)}" is not in the catalogue.` : 'No model in the file.';
    else if (model === 'ambiguous') why = `"${modelText.slice(0, 40)}" matches more than one catalogue model.`;
    else if (!rack) why = rackText ? `No rack called "${rackText.slice(0, 40)}".` : 'No rack in the file.';
    else if (!Number.isInteger(unit) || unit < 1) why = 'No whole rack unit in the file.';
    else if (unit + model.rackUnits - 1 > rack.heightU) why = `U${unit} does not fit in ${rack.label}.`;
    else {
      let free = true;
      for (let u = unit; u < unit + model.rackUnits; u += 1) if (rack.taken[u]) free = false;
      if (!free) why = `U${unit} in ${rack.label} is taken.`;
      else {
        for (let u = unit; u < unit + model.rackUnits; u += 1) rack.taken[u] = true;
        item.placement = { rackId: rack.id, unit, face, model };
      }
    }
    if (item.placement) return;
    item.bucket = 'nomodel';
    item.reason = why;
    if (modelText) item.notes.push(`Model in the file: ${modelText}`);
  });

  const counts: Record<Bucket, number> = { new: 0, match: 0, differ: 0, nomodel: 0, skipped: 0 };
  let warnings = 0;
  for (const i of items) {
    counts[i.bucket] += 1;
    warnings += i.warnings.length;
  }
  return { items, newFields, counts, warnings };
}

/** Sets `bucket` to match or differ and records what would fill and what disagrees. */
function compareWithExisting(item: PlanItem, found: ExistingDevice, ctx: PlanContext): void {
  item.existing = found;
  const add = (key: string, label: string, mine: string, theirs: string | undefined, equal = same) => {
    if (!theirs) return;
    if (!mine) item.fills.push({ key, label, mine, theirs });
    else if (!equal(mine, theirs)) item.conflicts.push({ key, label, mine, theirs });
  };
  add('serial', 'Serial', found.serial, item.serial);
  add('role', 'Role', found.role, item.role);
  add('mgmt', 'Management address', found.mgmt, item.mgmt);
  item.fields.forEach((f, i) => {
    if ('defId' in f.ref) add(`field:${i}`, f.label, fieldValue(ctx.doc, found.deviceId, f.ref.defId) ?? '', f.value);
    else item.fills.push({ key: `field:${i}`, label: f.label, mine: '', theirs: f.value });
  });
  const have = new Set(tagsOf(ctx.doc, found.deviceId).map((t) => t.name.toLowerCase()));
  for (const t of item.tags) if (!have.has(t.toLowerCase())) item.fills.push({ key: `tag:${t}`, label: 'Tag', mine: '', theirs: t });
  const notes = new Set(notesOf(ctx.doc, found.deviceId).map((n) => n.text.trim()));
  for (const t of item.notes) if (!notes.has(t.trim())) item.fills.push({ key: 'note', label: 'Note', mine: '', theirs: t });
  item.bucket = item.conflicts.length > 0 ? 'differ' : 'match';
}
