// Step 3, Import: writes a plan into the design through the same commands the Inventory table and
// the canvas use, then merges everything into ONE batch so a single undo removes the lot.
// A fill never replaces a value that is there; only a Differ row the person set to "file" does.

import { createSketchDevice, placeChassis } from '../document/commands';
import { collapseBatches } from '../document/collapse';
import { setChassisField, setDeviceField } from '../document/edit';
import { fieldValue, setFieldValues, type FieldDefView, type FieldSet } from '../document/fields';
import { findNode, parseNodeId, type Document } from '../document/model';
import { addNote } from '../document/notes';
import { tagObject } from '../document/tags';
import { choiceKey, type Diff, type FieldRef, type Plan, type PlanItem } from './plan';

export type Pick = 'mine' | 'theirs';

export interface ApplyOptions {
  /** Differ rows by `choiceKey`; a row not listed keeps what is there. */
  choices?: ReadonlyMap<string, Pick>;
  /** Every live definition, including the ones just created. */
  defs: readonly FieldDefView[];
  /** The definition made for each of `plan.newFields`, same order. */
  fresh: readonly FieldDefView[];
  actor?: string;
  now?: number;
  /** The history label, e.g. "import devices.csv". */
  label: string;
  /** Called every few rows; the work is split across ticks so the page stays alive. */
  onProgress?: (done: number, total: number) => void;
}

export interface ApplyResult {
  doc: Document;
  created: number;
  placed: number;
  /** Blank values filled in on devices that were already there. */
  filled: number;
  /** Values replaced because the person chose the file's. */
  overwritten: number;
  /** Things the commands refused, by device. */
  refused: string[];
}

/** The history label. It never holds the file name: that is the person's, and history is shared. */
export function importLabel(rows: number): string {
  return `import (${rows} ${rows === 1 ? 'row' : 'rows'})`;
}

function addedNodeIds(before: Document, after: Document): string[] {
  return after.batches.slice(before.batches.length).flatMap((b) => b.ops.flatMap((o) => (o.type === 'add_node' ? [o.node] : [])));
}

const msg = (e: unknown) => (e instanceof Error ? e.message : 'refused');

export async function applyPlan(doc: Document, plan: Plan, opts: ApplyOptions): Promise<ApplyResult> {
  const stamp = { ...(opts.actor !== undefined ? { actor: opts.actor } : {}), ...(opts.now !== undefined ? { now: opts.now } : {}) };
  const defIdOf = (ref: FieldRef): string => {
    if ('defId' in ref) return ref.defId;
    const d = opts.fresh[ref.fresh];
    if (!d) throw new Error('a new shared field was not created');
    return d.id;
  };
  for (let i = 0; i < plan.newFields.length; i += 1) defIdOf({ fresh: i });

  let working = doc;
  const sets: FieldSet[] = [];
  const result: ApplyResult = { doc, created: 0, placed: 0, filled: 0, overwritten: 0, refused: [] };

  const writeValue = (w: Document, item: PlanItem, ids: { deviceId: string; chassisId: string }, d: Diff, overwrite: boolean): Document => {
    if (d.key === 'serial' || d.key === 'role' || d.key === 'mgmt') {
      const node = findNode(w, d.key === 'serial' ? ids.chassisId : ids.deviceId);
      const entry = node?.fields[d.key === 'serial' ? 'Chassis.serial' : d.key === 'role' ? 'Device.role' : 'Device.management_address'];
      const have = entry && entry.presence === 'set' && typeof entry.value === 'string' ? entry.value : '';
      if (have !== '' && !overwrite) return w;
      if (have === d.theirs) return w;
      if (d.key === 'serial') return setChassisField(w, ids.chassisId, 'serial', d.theirs, stamp);
      return setDeviceField(w, ids.deviceId, d.key === 'mgmt' ? 'management_address' : 'role', d.theirs, stamp);
    }
    if (d.key.startsWith('field:')) {
      const f = item.fields[Number(d.key.slice(6))];
      if (!f) return w;
      const defId = defIdOf(f.ref);
      const have = fieldValue(w, ids.deviceId, defId) ?? '';
      if (have !== '' && !overwrite) return w;
      if (have !== f.value) sets.push({ ownerId: ids.deviceId, defId, raw: f.value });
      return w;
    }
    return w;
  };

  const addTagsAndNotes = (w: Document, item: PlanItem, deviceId: string, only?: { tags: Set<string>; notes: Set<string> }): Document => {
    let next = w;
    for (const t of item.tags) {
      if (only && !only.tags.has(t)) continue;
      try {
        next = tagObject(next, deviceId, t, stamp);
      } catch (e) {
        result.refused.push(`${item.name}: tag "${t}": ${msg(e)}`);
      }
    }
    for (const text of item.notes) {
      if (only && !only.notes.has(text)) continue;
      next = addNote(next, deviceId, { text, how: 'pasted', lineCount: text.split('\n').length, ...stamp });
    }
    return next;
  };

  let n = 0;
  for (const item of plan.items) {
    n += 1;
    if (n % 20 === 0) {
      opts.onProgress?.(n, plan.items.length);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (item.bucket === 'skipped') continue;
    const mark = sets.length;
    try {
      let w = working;
      if (item.existing) {
        const ids = { deviceId: item.existing.deviceId, chassisId: item.existing.chassisId };
        const theirs = item.bucket === 'differ' && opts.choices?.get(choiceKey(item)) === 'theirs';
        const tags = new Set<string>();
        const notes = new Set<string>();
        for (const d of item.fills) {
          if (d.key.startsWith('tag:')) tags.add(d.theirs);
          else if (d.key === 'note') notes.add(d.theirs);
          else w = writeValue(w, item, ids, d, false);
        }
        if (theirs) for (const d of item.conflicts) w = writeValue(w, item, ids, d, true);
        w = addTagsAndNotes(w, item, ids.deviceId, { tags, notes });
        result.filled += item.fills.length;
        if (theirs) result.overwritten += item.conflicts.length;
      } else {
        const before = w;
        if (item.placement) {
          const p = item.placement;
          w = placeChassis(w, p.rackId, p.model, p.unit, p.face, stamp);
        } else {
          w = createSketchDevice(w, { hostname: item.name, ...stamp });
        }
        const added = addedNodeIds(before, w);
        const deviceId = added.find((id) => parseNodeId(id).kind === 'Device')!;
        const chassisId = added.find((id) => parseNodeId(id).kind === 'Chassis')!;
        if (item.placement) w = setDeviceField(w, deviceId, 'hostname', item.name, stamp);
        if (item.role) w = setDeviceField(w, deviceId, 'role', item.role, stamp);
        if (item.mgmt) w = setDeviceField(w, deviceId, 'management_address', item.mgmt, stamp);
        if (item.serial) w = setChassisField(w, chassisId, 'serial', item.serial, stamp);
        item.fields.forEach((f, i) => sets.push({ ownerId: deviceId, defId: defIdOf(f.ref), raw: item.fields[i]!.value }));
        w = addTagsAndNotes(w, item, deviceId);
        result.created += 1;
        if (item.placement) result.placed += 1;
      }
      working = w;
    } catch (e) {
      sets.length = mark;
      result.refused.push(`${item.name}: ${msg(e)}`);
    }
  }

  if (sets.length > 0) {
    try {
      working = setFieldValues(working, sets, opts.defs, stamp);
    } catch {
      for (const s of sets) {
        try {
          working = setFieldValues(working, [s], opts.defs, stamp);
        } catch (e) {
          result.refused.push(`${s.ownerId}: ${msg(e)}`);
        }
      }
    }
  }
  result.doc = collapseBatches(doc, working, opts.label);
  return result;
}
