// Edit many at once: the same commands one device takes, run over several devices and folded into ONE
// batch, so a single undo reverses the whole change. Nothing here writes a field the schema lacks; each
// step is an existing command (`tagObject`, `untagObject`, `setDeviceField`, `movePlacement`).

import { movePlacement } from './commands';
import { setDeviceField } from './edit';
import type { Document } from './model';
import { foldTagName, listTags, tagObject, tagsOf, TagRefusalError, untagObject, type TagSummary } from './tags';
import type { Placement } from './view';

type Actor = { actor?: string; now?: number } | undefined;

/** Folds every batch added after the first `from` into one (as `racks/RacksPlace.tsx`'s `oneUndoStep` does). */
export function foldIntoOneBatch(doc: Document, from: number, label: string): Document {
  const added = doc.batches.slice(from);
  if (added.length < 2) return doc;
  const merged = { ...added[0]!, label, ops: added.flatMap((b) => b.ops) };
  return { ...doc, batches: [...doc.batches.slice(0, from), merged] };
}

export interface ManyTagChip {
  /** Any tag node id of the group, for removing it. */
  tagId: string;
  name: string;
  /** How many of the chosen things carry it. */
  count: number;
  /** How many things were chosen. */
  total: number;
}

/** Every tag carried by at least one of `ownerIds`, with how many carry it. */
export function tagsOfMany(doc: Document, ownerIds: readonly string[]): ManyTagChip[] {
  const byKey = new Map<string, ManyTagChip>();
  for (const id of ownerIds) {
    for (const chip of tagsOf(doc, id)) {
      const key = foldTagName(chip.name);
      const seen = byKey.get(key);
      if (seen) seen.count += 1;
      else byKey.set(key, { tagId: chip.tagId, name: chip.name, count: 1, total: ownerIds.length });
    }
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Every tag in the design, for the suggestions. */
export function allTagSummaries(doc: Document): TagSummary[] {
  return listTags(doc);
}

/** Tags every one of `ownerIds` with `name`; one already carrying it is left alone. A bad name is refused (and nothing changes). */
export function tagMany(doc: Document, ownerIds: readonly string[], name: string, opts?: Actor): Document {
  const from = doc.batches.length;
  let next = doc;
  for (const id of ownerIds) {
    try {
      next = tagObject(next, id, name, opts);
    } catch (e) {
      if (e instanceof TagRefusalError && e.code === 'already-tagged') continue;
      throw e;
    }
  }
  return foldIntoOneBatch(next, from, 'tag');
}

/** Takes the tag off every one of `ownerIds` that carries it. */
export function untagMany(doc: Document, ownerIds: readonly string[], tagId: string, opts?: Actor): Document {
  const from = doc.batches.length;
  let next = doc;
  for (const id of ownerIds) {
    try {
      next = untagObject(next, id, tagId, opts);
    } catch (e) {
      if (e instanceof TagRefusalError && e.code === 'not-tagged') continue;
      throw e;
    }
  }
  return foldIntoOneBatch(next, from, 'untag');
}

/** Sets the role on each device; `role: null` clears it. */
export function setRoleMany(doc: Document, deviceIds: readonly string[], role: string | null, opts?: Actor): Document {
  const from = doc.batches.length;
  let next = doc;
  for (const id of deviceIds) next = setDeviceField(next, id, 'role', role, opts);
  return foldIntoOneBatch(next, from, 'set role');
}

export interface RackMove {
  /** The chassis id. */
  itemId: string;
  rackId: string;
  positionU: number;
}

/** Moves each chassis to its unit in a rack, front face. */
export function moveManyToRack(doc: Document, moves: readonly RackMove[], opts?: Actor): Document {
  const from = doc.batches.length;
  let next = doc;
  for (const m of moves) {
    const placement: Placement = { kind: 'rack', rackId: m.rackId, positionU: m.positionU, face: 'front' };
    next = movePlacement(next, m.itemId, placement, opts);
  }
  return foldIntoOneBatch(next, from, 'move devices');
}
