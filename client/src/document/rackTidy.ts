// Round 15 quality-of-life (r15-qol): close the gaps in a rack, and copy a whole rack with its
// cables. Each is built from the commands a person could run one by one (`movePlacement`,
// `createRack`, `duplicateDevice`, `createShelf`, `connectPorts`) and folded into ONE batch, so a
// single undo reverses it. Pure.

import type { CatalogueModel } from '../api/catalogue';
import { foldIntoOneBatch } from './bulk';
import { connectPorts, isCableMedia, isSheath, setCableField } from './cables';
import { createRack, createShelf, duplicateDevice, movePlacement, resizeShelf } from './commands';
import {
  UnknownReferenceError,
  edgesIn,
  edgesOut,
  findNode,
  parseNodeId,
  readDeviceFields,
  readMountedInFields,
  readPassiveNodeFields,
  readPhysicalPortFields,
  readRackFields,
  readSitsOnFields,
  type Document,
  type GraphEdge,
} from './model';

type Actor = { actor?: string; now?: number };

interface Mounted {
  itemId: string;
  edge: GraphEdge;
  positionU: number;
  heightU: number;
  face: 'front' | 'rear';
}

function mountedIn(doc: Document, rackId: string): Mounted[] {
  return edgesIn(doc, rackId, 'MountedIn')
    .map((edge) => {
      const f = readMountedInFields(edge);
      return { itemId: edge.from, edge, positionU: f.positionU ?? 1, heightU: f.heightU ?? 1, face: f.face === 'rear' ? ('rear' as const) : ('front' as const) };
    })
    .filter((m) => {
      const n = findNode(doc, m.itemId);
      return n !== undefined && n.absentSince === undefined;
    });
}

function requireRack(doc: Document, rackId: string) {
  const rack = findNode(doc, rackId);
  if (!rack || rack.absentSince !== undefined || parseNodeId(rackId).kind !== 'Rack') throw new UnknownReferenceError(rackId, 'Rack');
  return rack;
}

/** The gaps between the things in a rack, top down, in units. */
export function rackGaps(doc: Document, rackId: string): number {
  const items = mountedIn(doc, rackId).sort((a, b) => b.positionU + b.heightU - (a.positionU + a.heightU));
  let gaps = 0;
  for (let i = 1; i < items.length; i += 1) {
    const above = items[i - 1]!;
    const top = items[i]!.positionU + items[i]!.heightU - 1;
    if (above.positionU - 1 > top) gaps += above.positionU - 1 - top;
  }
  return gaps;
}

/**
 * Slides everything in the rack up against the thing above it, keeping their order and faces; the
 * topmost thing stays where it is. Shelves move with what sits on them. `moved` is 0 (and the
 * document unchanged) when there was no gap.
 */
export function closeRackGaps(doc: Document, rackId: string, opts?: Actor): { doc: Document; moved: number } {
  requireRack(doc, rackId);
  // Highest top first: each one only ever moves up into space the one above it just left free.
  const items = mountedIn(doc, rackId).sort((a, b) => b.positionU + b.heightU - (a.positionU + a.heightU));
  if (items.length < 2) return { doc, moved: 0 };
  const from = doc.batches.length;
  let working = doc;
  let moved = 0;
  let cursor = items[0]!.positionU + items[0]!.heightU - 1;
  for (const item of items) {
    const positionU = cursor - item.heightU + 1;
    if (positionU !== item.positionU) {
      working = movePlacement(working, item.itemId, { kind: 'rack', rackId, positionU, face: item.face }, opts);
      moved += 1;
    }
    cursor = positionU - 1;
  }
  return { doc: moved === 0 ? doc : foldIntoOneBatch(working, from, 'close rack gaps'), moved };
}

/** `name-2`, or `-3` and so on when that is taken. */
export function suffixName(taken: ReadonlySet<string>, name: string): string {
  let n = 2;
  while (taken.has(`${name}-${n}`)) n += 1;
  return `${name}-${n}`;
}

/** R1 gives R2 (the next free number); a name with no number gets `-2`. */
export function nextRackLabel(taken: ReadonlySet<string>, label: string): string {
  const m = /^(.*?)(\d+)$/.exec(label);
  if (!m) return suffixName(taken, label);
  let n = Number(m[2]);
  let next: string;
  do {
    n += 1;
    next = `${m[1]}${String(n).padStart(m[2]!.length, '0')}`;
  } while (taken.has(next));
  return next;
}

/** Every port on a chassis and on its fitted supplies, by label. A label used twice is left out. */
function portsByLabel(doc: Document, chassisId: string): Map<string, string> {
  const ids = edgesOut(doc, chassisId, 'HasPort').map((e) => e.to);
  for (const fitted of edgesOut(doc, chassisId, 'FittedIn')) ids.push(...edgesOut(doc, fitted.to, 'HasPort').map((e) => e.to));
  const out = new Map<string, string>();
  const twice = new Set<string>();
  for (const id of ids) {
    const n = findNode(doc, id);
    const label = n && n.absentSince === undefined ? readPhysicalPortFields(n).label : undefined;
    if (label === undefined) continue;
    if (out.has(label)) twice.add(label);
    out.set(label, id);
  }
  for (const l of twice) out.delete(l);
  return out;
}

function hostnameOf(doc: Document, chassisId: string): string | undefined {
  const has = edgesIn(doc, chassisId, 'HasChassis')[0];
  const device = has ? findNode(doc, has.from) : undefined;
  return device ? readDeviceFields(device).hostname : undefined;
}

export interface CopyRackResult {
  doc: Document;
  rackId: string;
  label: string;
  devices: number;
  cables: number;
  /** Things in the rack a copy does not make (a patch panel or other passive that is not a shelf). */
  skipped: number;
}

/**
 * A new rack beside the source, the same height and numbering, named the next in sequence (R1 gives
 * R2), holding a copy of every device and shelf at the same units and faces, and a copy of every
 * cable that runs between two things inside the rack. Device names get `-2`. Serials, notes and
 * addresses are never copied (`duplicateDevice`). One batch.
 */
export function copyRack(doc: Document, rackId: string, opts: Actor & { catalogue?: readonly CatalogueModel[] } = {}): CopyRackResult {
  const rack = requireRack(doc, rackId);
  const fields = readRackFields(rack);
  const premises = edgesIn(doc, rackId, 'HasRack')[0];
  if (!premises) throw new UnknownReferenceError(rackId, 'a rack in a place');
  const actor = { actor: opts.actor, now: opts.now };
  const from = doc.batches.length;

  const rackLabels = new Set<string>();
  const names = new Set<string>();
  for (const n of doc.nodes) {
    if (n.absentSince !== undefined) continue;
    const l = n.fields['Rack.label']?.value;
    if (typeof l === 'string') rackLabels.add(l);
    const h = n.fields['Device.hostname']?.value;
    if (typeof h === 'string') names.add(h);
  }
  const label = nextRackLabel(rackLabels, fields.label ?? 'Rack');

  const before = new Set(doc.nodes.map((n) => n.id));
  let working = createRack(doc, premises.from, {
    ...actor,
    label,
    heightU: fields.heightU ?? 42,
    unitNumbering: fields.unitNumbering === 'descending' ? 'descending' : 'ascending',
  });
  const newRackId = working.nodes.find((n) => !before.has(n.id) && n.id.startsWith('rack:'))!.id;

  const chassisPairs: Array<[string, string]> = [];
  let skipped = 0;
  const copyDevice = (sourceChassisId: string, place: { positionU?: number; unplaced?: boolean }) => {
    const source = hostnameOf(doc, sourceChassisId);
    let hostname: string | undefined;
    if (source !== undefined) {
      hostname = suffixName(names, source);
      names.add(hostname);
    }
    const r = duplicateDevice(working, sourceChassisId, {
      ...actor,
      catalogue: opts.catalogue,
      ...(hostname !== undefined ? { hostname } : {}),
      ...(place.unplaced ? { unplaced: true } : { intoRackId: newRackId, positionU: place.positionU }),
    });
    working = r.doc;
    chassisPairs.push([sourceChassisId, r.chassisId]);
    return r.chassisId;
  };

  for (const item of mountedIn(doc, rackId).sort((a, b) => a.positionU - b.positionU)) {
    const kind = parseNodeId(item.itemId).kind;
    if (kind === 'Chassis') {
      // `duplicateDevice` keeps the source's face.
      copyDevice(item.itemId, { positionU: item.positionU });
      continue;
    }
    const passive = readPassiveNodeFields(findNode(doc, item.itemId)!);
    if (passive.form !== 'shelf') {
      skipped += 1;
      continue;
    }
    const model = passive.model !== undefined ? opts.catalogue?.find((m) => m.model === passive.model) : undefined;
    const shelfBefore = new Set(working.nodes.map((n) => n.id));
    working = createShelf(working, newRackId, { ...actor, positionU: item.positionU, label: passive.label ?? 'Shelf', ...(model ? { model } : {}) });
    const shelfId = working.nodes.find((n) => !shelfBefore.has(n.id) && n.id.startsWith('passive-node:'))!.id;
    const resize: { heightU?: number; slots?: number } = {};
    if (!model && item.heightU !== 1) resize.heightU = item.heightU;
    if (passive.slots !== undefined) resize.slots = passive.slots;
    if (resize.heightU !== undefined || resize.slots !== undefined) working = resizeShelf(working, shelfId, resize, { ...actor, catalogue: opts.catalogue });
    for (const sits of edgesIn(doc, item.itemId, 'SitsOn')) {
      if (parseNodeId(sits.from).kind !== 'Chassis') continue;
      const slot = readSitsOnFields(sits).slot;
      const copy = copyDevice(sits.from, { unplaced: true });
      if (slot !== undefined) working = movePlacement(working, copy, { kind: 'shelf', shelfId, slot }, actor);
    }
  }

  // Cables with both ends on things that were copied.
  const portMap = new Map<string, string>();
  for (const [src, dst] of chassisPairs) {
    const a = portsByLabel(doc, src);
    const b = portsByLabel(working, dst);
    for (const [l, id] of a) {
      const to = b.get(l);
      if (to !== undefined) portMap.set(id, to);
    }
  }
  let cables = 0;
  for (const node of doc.nodes) {
    if (node.absentSince !== undefined || !node.id.startsWith('cable:')) continue;
    const ends = edgesOut(doc, node.id, 'Terminates');
    if (ends.length !== 2) continue;
    const endOf = (e: GraphEdge) => e.fields['Terminates.end']?.value;
    const a = ends.find((e) => endOf(e) === 'a') ?? ends[0]!;
    const b = ends.find((e) => e !== a)!;
    const newA = portMap.get(a.to);
    const newB = portMap.get(b.to);
    if (newA === undefined || newB === undefined) continue;
    const media = node.fields['Cable.media']?.value;
    const sheath = node.fields['Cable.sheath']?.value;
    const cableBefore = new Set(working.nodes.map((n) => n.id));
    working = connectPorts(
      working,
      newA,
      newB,
      {
        ...(typeof media === 'string' && isCableMedia(media) ? { media } : {}),
        ...(typeof sheath === 'string' && isSheath(sheath) ? { sheath } : {}),
      },
      actor,
    );
    const length = node.fields['Cable.length_m']?.value;
    if (typeof length === 'number') {
      const cableId = working.nodes.find((n) => !cableBefore.has(n.id) && n.id.startsWith('cable:'))!.id;
      working = setCableField(working, cableId, 'length_m', length, actor);
    }
    cables += 1;
  }

  return { doc: foldIntoOneBatch(working, from, 'copy rack'), rackId: newRackId, label, devices: chassisPairs.length, cables, skipped };
}
