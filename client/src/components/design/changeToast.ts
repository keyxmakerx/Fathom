// The note at the bottom after you change something ("Port added", with Undo).
// Pure: which of the document's batches is a fresh one of yours, and how a batch's
// working label reads in plain words. The component is `ChangeToast.tsx`.

import { findEdge, findNode, parseEdgeId, parseNodeId, readChassisFields, readDeviceFields, readRackFields } from '../../document/model';
import type { Batch, Document } from '../../document/model';
import { batchActor } from '../../document/undo';

/** A batch's label as a short sentence. The labels are written for the trail; this is for a person. */
const WORDS: Readonly<Record<string, string>> = {
  'place chassis': 'Device added',
  'create sketch device': 'Device added',
  'duplicate device': 'Device copied',
  'remove chassis': 'Device removed',
  'move chassis': 'Device moved',
  'move placement': 'Device moved',
  'move': 'Moved',
  'move selection': 'Moved',
  'pin': 'Box added',
  'add sketch port': 'Port added',
  'remove sketch port': 'Port removed',
  'create shelf': 'Shelf added',
  'resize shelf': 'Shelf resized',
  'place on shelf': 'Placed on the shelf',
  'create surface': 'Surface added',
  'create board': 'Board added',
  'create rack': 'Rack added',
  'fix to': 'Fixed in place',
  'connect ports': 'Cable connected',
  'connect to outside': 'Cable connected',
  'disconnect cable': 'Cable removed',
  'fit supply': 'Power supply fitted',
  'remove supply': 'Power supply removed',
  'add note': 'Note added',
  'remove note': 'Note removed',
  'tag': 'Tag added',
  'untag': 'Tag removed',
  'rename tag': 'Tag renamed',
  'remove tag': 'Tag removed',
  'tag VLAN': 'Tag added',
  'untag VLAN': 'Tag removed',
  'add label': 'Label added',
  'add area': 'Area added',
  'edit label': 'Label changed',
  'set field': 'Field changed',
  'set fields': 'Fields changed',
  'add doc': 'Doc added',
  'edit doc': 'Doc changed',
  'remove doc': 'Doc removed',
  'add link': 'Link added',
  'remove link': 'Link removed',
  'add file': 'File added',
  'remove file': 'File removed',
  'remove VLAN': 'VLAN removed',
  'remove subnet': 'Subnet removed',
  'detach address': 'Address removed',
  'remove container': 'Container removed',
  'remove Docker network': 'Docker network removed',
  'remove published port': 'Published port removed',
};

/** What `set Device.hostname`-style labels say, by field. */
const FIELD_WORDS: Readonly<Record<string, string>> = {
  'Device.hostname': 'Name changed',
  'Device.role': 'Role changed',
  'Device.management_address': 'Address changed',
  'Chassis.serial': 'Serial number changed',
  'Rack.label': 'Rack renamed',
  'Rack.row': 'Rack moved to another row',
  'Rack.bay': 'Rack moved to another bay',
  'Rack.height_u': 'Rack height changed',
  'PassiveNode.label': 'Name changed',
  'Cable.label': 'Cable label changed',
  'Cable.length_m': 'Cable length changed',
  'Cable.sheath': 'Cable colour changed',
};

function sentence(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}

/** The words for a plain (not undo, not redo) label. Unknown labels read as themselves, as a sentence. */
function plainWords(label: string): string {
  const known = WORDS[label];
  if (known !== undefined) return known;
  const field = /^set (\S+)$/.exec(label);
  if (field !== null) return FIELD_WORDS[field[1]!] ?? 'Changed';
  const ports = /^add (\d+) ports$/.exec(label);
  if (ports !== null) return ports[1] === '1' ? 'Port added' : `${ports[1]} ports added`;
  const container = /^add container (.+)$/.exec(label);
  if (container !== null) return `Container ${container[1]} added`;
  if (/^(add|attach to) (subnet|VLAN)/.test(label)) return sentence(label.replace(/^attach to /, 'added to '));
  return sentence(label);
}

/** "Port added", or for an undo "Undone: port added". */
export function toastWords(label: string): string {
  const m = /^(undo|redo) of (.+)$/.exec(label);
  if (m === null) return plainWords(label);
  let root = m[2]!;
  let nested = /^(undo|redo) of (.+)$/.exec(root);
  while (nested !== null) {
    root = nested[2]!;
    nested = /^(undo|redo) of (.+)$/.exec(root);
  }
  return `${m[1] === 'undo' ? 'Undone' : 'Redone'}: ${lowerFirst(plainWords(root))}`;
}

function elementsOf(batch: Batch): string[] {
  return batch.ops.flatMap((op) => (op.type === 'add_node' ? [op.node] : op.type === 'add_edge' ? [op.edge] : [op.element]));
}

const edgeKind = (id: string): string | null => {
  try {
    return parseEdgeId(id).kind;
  } catch {
    return null;
  }
};

const nodeKind = (id: string): string | null => {
  try {
    return parseNodeId(id).kind;
  } catch {
    return null;
  }
};

/** The device a batch is about and the rack it is in, read from the batch's own elements (a removed
 * device is still in the document, marked absent). Null for either when the batch does not say. */
export function batchSubject(doc: Document, batch: Batch): { name: string | null; rack: string | null } {
  let chassisId: string | null = null;
  let rackId: string | null = null;
  let deviceId: string | null = null;
  for (const id of elementsOf(batch)) {
    const nk = nodeKind(id);
    if (nk === 'Chassis' && chassisId === null) chassisId = id;
    if (nk === 'Device' && deviceId === null) deviceId = id;
    const ek = edgeKind(id);
    const edge = ek === null ? undefined : findEdge(doc, id);
    if (edge === undefined) continue;
    if (ek === 'MountedIn') {
      chassisId ??= edge.from;
      // A move rewrites the edge's fields; a place or remove names the rack it joined or left.
      if (nodeKind(edge.to) === 'Rack') rackId ??= edge.to;
    } else if (ek === 'HasChassis') {
      deviceId ??= edge.from;
      chassisId ??= edge.to;
    } else if (ek === 'HasPort') {
      chassisId ??= edge.from;
    }
  }
  if (chassisId !== null && deviceId === null) {
    const owner = doc.edges.find((e) => e.to === chassisId && edgeKind(e.id) === 'HasChassis');
    deviceId = owner?.from ?? null;
  }
  const device = deviceId === null ? undefined : findNode(doc, deviceId);
  const chassis = chassisId === null ? undefined : findNode(doc, chassisId);
  const name = (device ? readDeviceFields(device).hostname : undefined) || (chassis ? readChassisFields(chassis).model : undefined) || null;
  const rackNode = rackId === null ? undefined : findNode(doc, rackId);
  const rack = (rackNode ? readRackFields(rackNode).label : undefined) || null;
  return { name, rack };
}

/** The note's words for a plain change, naming the device and rack where the batch says them
 * ("Removed switch-1 from R1"); otherwise the generic words for the label. */
export function namedWords(doc: Document, batch: Batch): string {
  const generic = toastWords(batch.label);
  if (!['remove chassis', 'place chassis', 'duplicate device', 'create sketch device', 'move chassis', 'move placement', 'add sketch port', 'remove sketch port'].includes(batch.label)) return generic;
  const { name, rack } = batchSubject(doc, batch);
  if (name === null) return generic;
  switch (batch.label) {
    case 'remove chassis':
      return rack === null ? `Removed ${name}` : `Removed ${name} from ${rack}`;
    case 'place chassis':
      return rack === null ? `Added ${name}` : `Added ${name} to ${rack}`;
    case 'duplicate device':
      return rack === null ? `Copied ${name}` : `Copied ${name} to ${rack}`;
    case 'create sketch device':
      return `Added ${name}`;
    case 'move chassis':
    case 'move placement':
      return rack === null ? `Moved ${name}` : `Moved ${name} in ${rack}`;
    case 'add sketch port':
      return `Port added to ${name}`;
    default:
      return `Port removed from ${name}`;
  }
}

export interface FreshChange {
  batchId: string;
  words: string;
  /** What the batch was: a change you made, or your own undo or redo. */
  kind: 'change' | 'undo' | 'redo';
}

/**
 * The batch `next` gained since `prev` that this account wrote, newest first, or null. Nothing for a
 * teammate's live edit, a first load, or a document swapped for another (the batch we last saw is gone).
 */
export function freshOwnChange(prev: Document | null, next: Document, accountId: string | null): FreshChange | null {
  if (prev === null || accountId === null || prev === next) return null;
  const lastSeen = prev.batches[prev.batches.length - 1];
  let from = 0;
  if (lastSeen !== undefined) {
    const at = next.batches.findIndex((b) => b.id === lastSeen.id);
    if (at < 0) return null;
    from = at + 1;
  }
  for (let i = next.batches.length - 1; i >= from; i -= 1) {
    const batch: Batch = next.batches[i]!;
    if (batchActor(next, batch) !== accountId) continue;
    const reversal = /^(undo|redo) of /.exec(batch.label);
    const kind = batch.reverses === undefined ? 'change' : reversal?.[1] === 'redo' ? 'redo' : 'undo';
    return { batchId: batch.id, words: kind === 'change' ? namedWords(next, batch) : toastWords(batch.label), kind };
  }
  return null;
}
