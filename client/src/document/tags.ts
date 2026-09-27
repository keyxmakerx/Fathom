// ADR-0059 — a tag is a node, not a field: `Tag`, one field `name`, found by
// scanning `doc.nodes` for the kind (`HasTag` reads `from: [root]`, and
// `cables.ts`'s own header explains why a root-containment edge is never
// actually written: `check_edge_l0` refuses it outright, so a `Tag` is a
// forest root with no containment edge at all, exactly like `Cable` and
// `Premises`). Objects point at a tag through `TaggedWith`, a reference edge
// -- `docker.ts`'s `AttachedTo` is the shape this module copies.
//
// A name is a tag's identity (decision 5): trimmed, inner runs of whitespace
// collapsed to one space, 1 to 64 characters. Two names equal ignoring case
// are the same tag -- enforced here, at the editor, never in the schema
// (decision 5's own "what it gives up"), so a payload holding two same-named
// tags still opens and this module's readers treat them as one.

import {
  LOCAL_ACTOR,
  UnknownReferenceError,
  archiveField,
  assertHand,
  edgesIn,
  edgesOut,
  findNode,
  formatEdgeId,
  formatNodeId,
  parseNodeId,
  replaceNode,
  requireFieldName,
  text,
  withBatch,
  withEdge,
  withNode,
  type Batch,
  type Document,
  type FieldEntry,
  type GraphNode,
  type NodeKind,
  type Op,
} from './model';
import { cascadeRemoval } from './cascade';
import { newUlid } from './ulid';

interface Actor {
  actor?: string;
  now?: number;
}

function resolve(opts: Actor | undefined): { actor: string; now: number } {
  return { actor: opts?.actor ?? LOCAL_ACTOR, now: opts?.now ?? Date.now() };
}

/** `Taggable` (`schema/schema.yaml`) — the kinds a `TaggedWith` edge may
 * carry `from:`. A `Vlan` row is tagged through its members (decision 6),
 * never directly by the row itself, which is derived and has no node id of
 * its own — `Vlan` stays in this list because each MEMBER is a real node. */
const TAGGABLE_KINDS: readonly NodeKind[] = [
  'Device',
  'PassiveNode',
  'PhysicalPort',
  'Cable',
  'Rack',
  'Premises',
  'Vlan',
  'ContainerNetwork',
  'Container',
];

export type TagRefusalCode =
  | 'unknown-reference'
  | 'not-taggable'
  | 'not-a-tag'
  | 'name-blank'
  | 'name-too-long'
  | 'name-in-use'
  | 'already-tagged'
  | 'not-tagged';

export class TagRefusalError extends Error {
  readonly code: TagRefusalCode;
  constructor(code: TagRefusalCode, message: string) {
    super(message);
    this.name = 'TagRefusalError';
    this.code = code;
  }
}

function refuse(code: TagRefusalCode, message: string): never {
  throw new TagRefusalError(code, message);
}

function fieldValue(fields: Readonly<Record<string, FieldEntry>>, key: string): FieldEntry['value'] | undefined {
  const e = fields[key];
  return e && e.presence === 'set' ? e.value : undefined;
}

function asString(v: FieldEntry['value'] | undefined): string {
  return typeof v === 'string' ? v : '';
}

function tagName(node: GraphNode): string {
  return asString(fieldValue(node.fields, 'Tag.name'));
}

/** Decision 5, verbatim: trim, collapse inner runs of whitespace to one
 * space, refuse outside 1..64 characters. Refuses by name and writes
 * nothing — the caller never sees a half-normalised name land. */
export function normalizeTagName(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, ' ');
  if (collapsed.length === 0) {
    refuse('name-blank', 'a tag name must not be blank');
  }
  if (collapsed.length > 64) {
    refuse('name-too-long', `a tag name must be 64 characters or fewer, got ${collapsed.length}`);
  }
  return collapsed;
}

/** Decision 5: two names equal ignoring case are the same tag. */
export function foldTagName(name: string): string {
  return name.toLowerCase();
}

function requireLiveTaggable(doc: Document, id: string): void {
  const n = findNode(doc, id);
  if (!n || n.absentSince !== undefined) {
    throw new UnknownReferenceError(id, 'a live object in this document');
  }
  if (!TAGGABLE_KINDS.includes(parseNodeId(id).kind)) {
    refuse('not-taggable', `"${id}" is not a Device, PassiveNode, PhysicalPort, Cable, Rack, Premises, Vlan, ContainerNetwork or Container`);
  }
}

function requireLiveTag(doc: Document, id: string): GraphNode {
  const n = findNode(doc, id);
  if (!n || n.absentSince !== undefined || parseNodeId(id).kind !== 'Tag') {
    refuse('not-a-tag', `"${id}" is not a live Tag in this document`);
  }
  return n;
}

/** Every live `Tag` node, in `doc.nodes` order (id order — `withNode`'s own
 * sort), which is what makes the first node in a duplicate-name group the
 * same one on every read. */
function liveTagNodes(doc: Document): GraphNode[] {
  return doc.nodes.filter((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Tag');
}

/** The first live tag (id order) whose folded name matches — decision 5's
 * "readers treat two such tags as one", read from the low side. */
function findLiveTagByFoldedName(doc: Document, folded: string): GraphNode | undefined {
  return liveTagNodes(doc).find((n) => foldTagName(tagName(n)) === folded);
}

function isLiveTaggedWith(doc: Document, objectId: string, tagId: string): boolean {
  return edgesOut(doc, objectId, 'TaggedWith').some((e) => e.absentSince === undefined && e.to === tagId);
}

/** Creates the `Tag` node if `rawName`'s fold matches no live tag, or reuses
 * the one that already carries it (decision 5). No containment edge is
 * written for it — `HasTag` reads `from: [root]`, and a root-containment
 * edge is refused outright wherever this document's writes are checked
 * (`cables.ts`'s own header comment). */
function ensureTag(
  doc: Document,
  now: number,
  actor: string,
  rawName: string,
): { doc: Document; tagId: string; name: string; ops: Op[] } {
  const name = normalizeTagName(rawName);
  const folded = foldTagName(name);
  const existing = findLiveTagByFoldedName(doc, folded);
  if (existing) {
    return { doc, tagId: existing.id, name: tagName(existing), ops: [] };
  }

  let working = doc;
  const ops: Op[] = [];
  const existence = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = existence.doc;
  const tagId = formatNodeId('Tag', newUlid(now));

  requireFieldName('Tag.name');
  const nameProv = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = nameProv.doc;
  const fields: Record<string, FieldEntry> = {
    'Tag.name': { presence: 'set', prov: nameProv.id, value: text(name) },
  };
  working = withNode(working, { id: tagId, existence: existence.id, fields });
  ops.push(
    { type: 'add_node', node: tagId, prov: existence.id },
    { type: 'set_field', element: tagId, key: 'Tag.name', presence: 'set', prov: nameProv.id },
  );
  return { doc: working, tagId, name, ops };
}

function addTaggedWithEdge(
  doc: Document,
  now: number,
  actor: string,
  objectId: string,
  tagId: string,
): { doc: Document; ops: Op[] } {
  const edgeProv = assertHand(doc, { assertedAt: now, assertedBy: actor });
  let working = edgeProv.doc;
  const edgeId = formatEdgeId('TaggedWith', newUlid(now));
  working = withEdge(working, { id: edgeId, from: objectId, to: tagId, prov: edgeProv.id, fields: {} });
  return { doc: working, ops: [{ type: 'add_edge', edge: edgeId, from: objectId, to: tagId, prov: edgeProv.id }] };
}

/**
 * ADR-0059 decisions 1/2/8 — tags `objectId` with `rawName`, creating the
 * `Tag` if its fold matches no live tag. One undoable batch. Refuses an
 * object this document has no live node for, one outside `Taggable`, or one
 * that already carries this tag.
 */
export function tagObject(doc: Document, objectId: string, rawName: string, opts?: Actor): Document {
  requireLiveTaggable(doc, objectId);
  const { actor, now } = resolve(opts);
  const ensured = ensureTag(doc, now, actor, rawName);
  if (isLiveTaggedWith(ensured.doc, objectId, ensured.tagId)) {
    refuse('already-tagged', `"${objectId}" is already tagged "${ensured.name}"`);
  }
  const edge = addTaggedWithEdge(ensured.doc, now, actor, objectId, ensured.tagId);
  const batch: Batch = { id: newUlid(now), label: 'tag', ops: [...ensured.ops, ...edge.ops] };
  return withBatch(edge.doc, batch);
}

/**
 * The reverse of `tagObject`: tombstones the one live `TaggedWith` edge from
 * `objectId` to `tagId`. The `Tag` node itself is untouched (decision 7 — a
 * tag outlives its last use). Refuses when there is no such live edge.
 */
export function untagObject(doc: Document, objectId: string, tagId: string, opts?: Actor): Document {
  const edge = edgesOut(doc, objectId, 'TaggedWith').find((e) => e.absentSince === undefined && e.to === tagId);
  if (!edge) refuse('not-tagged', `"${objectId}" does not carry tag "${tagId}"`);

  const { actor, now } = resolve(opts);
  const working: Document = { ...doc, edges: doc.edges.map((e) => (e.id === edge.id ? { ...e, absentSince: now } : e)) };
  const ops: Op[] = [{ type: 'tombstone', element: edge.id, at: now, by: actor }];
  return withBatch(working, { id: newUlid(now), label: 'untag', ops });
}

/**
 * ADR-0059 decision 8 — renames `tagId` to `rawName`. Refused by name when
 * another live tag already carries that name (case-insensitively); a
 * rename to a case variant of the tag's own current name is not a
 * collision (decision 5's own "what it gives up": merging is for later).
 */
export function renameTag(doc: Document, tagId: string, rawName: string, opts?: Actor): Document {
  const node = requireLiveTag(doc, tagId);
  const name = normalizeTagName(rawName);
  const folded = foldTagName(name);
  const collision = liveTagNodes(doc).find((n) => n.id !== tagId && foldTagName(tagName(n)) === folded);
  if (collision) refuse('name-in-use', `a tag named "${name}" already exists`);

  const { actor, now } = resolve(opts);
  const existing = node.fields['Tag.name'];
  const prov = assertHand(doc, { assertedAt: now, assertedBy: actor, supersedes: existing?.prov });
  let working = existing !== undefined ? archiveField(prov.doc, tagId, 'Tag.name', existing) : prov.doc;
  const entry: FieldEntry = { presence: 'set', prov: prov.id, value: text(name) };
  working = replaceNode(working, tagId, (n) => ({ ...n, fields: { ...n.fields, 'Tag.name': entry } }));
  const ops: Op[] = [{ type: 'set_field', element: tagId, key: 'Tag.name', presence: 'set', prov: prov.id }];
  return withBatch(working, { id: newUlid(now), label: 'rename tag', ops });
}

export interface TagChip {
  edgeId: string;
  tagId: string;
  name: string;
}

/** Every live tag `objectId` carries, one chip per distinct name — decision
 * 5's merge applied at read time, in case `objectId` somehow carries two
 * live edges to two duplicate-name tag nodes. */
export function tagsOf(doc: Document, objectId: string): TagChip[] {
  const byFold = new Map<string, TagChip>();
  for (const e of edgesOut(doc, objectId, 'TaggedWith')) {
    if (e.absentSince !== undefined) continue;
    const tagNode = findNode(doc, e.to);
    if (!tagNode || tagNode.absentSince !== undefined) continue;
    const name = tagName(tagNode);
    const folded = foldTagName(name);
    if (!byFold.has(folded)) byFold.set(folded, { edgeId: e.id, tagId: e.to, name });
  }
  return Array.from(byFold.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export interface TagSummary {
  id: string;
  name: string;
  count: number;
}

/** Every live tag in the design, its own name and how many live objects
 * carry it — a duplicate-name group (decision 5) reads as one row, the
 * first (lowest id) node's name, counts summed across the group. */
export function listTags(doc: Document): TagSummary[] {
  const byFold = new Map<string, TagSummary>();
  for (const n of liveTagNodes(doc)) {
    const name = tagName(n);
    const folded = foldTagName(name);
    const count = edgesIn(doc, n.id, 'TaggedWith').filter((e) => e.absentSince === undefined).length;
    const existing = byFold.get(folded);
    if (existing) {
      existing.count += count;
    } else {
      byFold.set(folded, { id: n.id, name, count });
    }
  }
  return Array.from(byFold.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Removes `tagId` and every live edge touching it — `cascade.ts`'s own
 * schema-driven cascade, so `TaggedWith` never needs a hand-kept list here.
 * Every tagged object loses the tag; none of them are otherwise touched
 * (decision 7).
 */
export function removeTag(doc: Document, tagId: string, opts?: Actor): Document {
  requireLiveTag(doc, tagId);
  const { actor, now } = resolve(opts);
  const { nodeIds, edgeIds } = cascadeRemoval(doc, tagId);
  const working: Document = {
    ...doc,
    nodes: doc.nodes.map((n) => (nodeIds.has(n.id) ? { ...n, absentSince: now } : n)),
    edges: doc.edges.map((e) => (edgeIds.has(e.id) ? { ...e, absentSince: now } : e)),
  };
  const ops: Op[] = [...nodeIds, ...edgeIds].map((element): Op => ({ type: 'tombstone', element, at: now, by: actor }));
  return withBatch(working, { id: newUlid(now), label: 'remove tag', ops });
}

// ---------------------------------------------------------------------------
// ADR-0059 decision 6 — a VLAN row is derived from several `Vlan` nodes
// (`networks-derive.ts`'s own `VlanRow.vlanNodeIds`). Tagging the row tags
// every member, untagging it untags every member, and the row's tags are the
// union of its members' tags. One undoable batch either way, whatever the
// member count.

/**
 * Tags every member of a VLAN row, creating the tag once if it is new.
 * Refuses only when every member already carries the tag — a partial
 * carry (one port tagged individually before the row existed) is not a
 * refusal, it is the row catching the rest up.
 */
export function tagVlanRow(doc: Document, vlanNodeIds: readonly string[], rawName: string, opts?: Actor): Document {
  if (vlanNodeIds.length === 0) refuse('unknown-reference', 'a VLAN row with no members cannot be tagged');
  for (const id of vlanNodeIds) requireLiveTaggable(doc, id);

  const { actor, now } = resolve(opts);
  const ensured = ensureTag(doc, now, actor, rawName);
  let working = ensured.doc;
  const ops: Op[] = [...ensured.ops];
  let addedAny = false;
  for (const id of vlanNodeIds) {
    if (isLiveTaggedWith(working, id, ensured.tagId)) continue;
    const edge = addTaggedWithEdge(working, now, actor, id, ensured.tagId);
    working = edge.doc;
    ops.push(...edge.ops);
    addedAny = true;
  }
  if (!addedAny) refuse('already-tagged', `every member of this VLAN already carries "${ensured.name}"`);
  return withBatch(working, { id: newUlid(now), label: 'tag VLAN', ops });
}

/** The reverse of `tagVlanRow`: untags every member that carries `tagId`.
 * Refuses when no member carries it. */
export function untagVlanRow(doc: Document, vlanNodeIds: readonly string[], tagId: string, opts?: Actor): Document {
  const { actor, now } = resolve(opts);
  const toTombstone: string[] = [];
  for (const id of vlanNodeIds) {
    const edge = edgesOut(doc, id, 'TaggedWith').find((e) => e.absentSince === undefined && e.to === tagId);
    if (edge) toTombstone.push(edge.id);
  }
  if (toTombstone.length === 0) refuse('not-tagged', `no member of this VLAN carries tag "${tagId}"`);

  const edgeIds = new Set(toTombstone);
  const working: Document = { ...doc, edges: doc.edges.map((e) => (edgeIds.has(e.id) ? { ...e, absentSince: now } : e)) };
  const ops: Op[] = toTombstone.map((element): Op => ({ type: 'tombstone', element, at: now, by: actor }));
  return withBatch(working, { id: newUlid(now), label: 'untag VLAN', ops });
}

/** The union of every member's tags, one chip per distinct name. */
export function tagsOfVlanRow(doc: Document, vlanNodeIds: readonly string[]): TagChip[] {
  const byFold = new Map<string, TagChip>();
  for (const id of vlanNodeIds) {
    for (const chip of tagsOf(doc, id)) {
      const folded = foldTagName(chip.name);
      if (!byFold.has(folded)) byFold.set(folded, chip);
    }
  }
  return Array.from(byFold.values()).sort((a, b) => a.name.localeCompare(b.name));
}
