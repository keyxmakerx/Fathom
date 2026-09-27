// ADR-0059: a tag is a `Tag` node that objects point at through `TaggedWith`. Tag nodes
// whose names fold to the same key (decision 5) read and write as one tag.

import {
  LOCAL_ACTOR,
  UnknownReferenceError,
  archiveField,
  assertHand,
  findNode,
  formatEdgeId,
  formatNodeId,
  kebab,
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
  type GraphEdge,
  type NodeKind,
  type Op,
} from './model';
import { cascadeRemoval } from './cascade';
import { newUlid } from './ulid';

// Kind filters over every node and edge check the id's `kebab(kind)` prefix;
// `parseNodeId` validates the ulid, which is too slow to run over them all.
const TAG_NODE_PREFIX = `${kebab('Tag')}:`;
const TAGGED_WITH_EDGE_PREFIX = `${kebab('TaggedWith')}:`;

interface Actor {
  actor?: string;
  now?: number;
}

function resolve(opts: Actor | undefined): { actor: string; now: number } {
  return { actor: opts?.actor ?? LOCAL_ACTOR, now: opts?.now ?? Date.now() };
}

/** `Taggable` in `schema/schema.yaml`. A VLAN row has no node of its own; it is tagged
 * through its member `Vlan` nodes (decision 6). */
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
  | 'name-invalid'
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

/** Decision 5: trim, collapse inner whitespace, refuse control (Cc), format (Cf) and lone
 * surrogate (Cs) characters, store NFC, and allow 1 to 64 code points. */
export function normalizeTagName(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, ' ');
  if (collapsed.length === 0) {
    refuse('name-blank', 'a tag name must not be blank');
  }
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(collapsed)) {
    refuse('name-invalid', 'a tag name must not contain control, invisible or broken characters');
  }
  const nfc = collapsed.normalize('NFC');
  const codePoints = Array.from(nfc).length;
  if (codePoints > 64) {
    refuse('name-too-long', `a tag name must be 64 characters or fewer, got ${codePoints}`);
  }
  return nfc;
}

/** Decision 5's comparison key: NFKC, upper-cased, then lower-cased, so ß/SS/ss,
 * full-width letters and composed or decomposed é each fold to one key. */
export function foldTagName(name: string): string {
  return name.normalize('NFKC').toUpperCase().toLowerCase();
}

// ---------------------------------------------------------------------------
// The tag index: one pass over nodes and edges, memoised per Document. Every
// write returns a new Document, so a cached index is never stale.

interface TagGroup {
  /** The comparison key (`foldTagName` of the canonical name). */
  key: string;
  /** The canonical (lowest id) node's own stored name — what every reader
   * shows for the group. */
  name: string;
  /** The lowest-id live node in the group — `tagObject`'s own reuse target. */
  canonicalId: string;
  /** Every live node in the group, lowest id first. */
  nodeIds: readonly string[];
}

interface TagIndex {
  /** Comparison key -> group. */
  groups: ReadonlyMap<string, TagGroup>;
  /** Any live Tag node id -> the key of the group it belongs to. */
  keyOfNode: ReadonlyMap<string, string>;
  /** Object id -> its own live `TaggedWith` edges out, in `doc.edges` order. */
  edgesOfObject: ReadonlyMap<string, readonly GraphEdge[]>;
  /** Group key -> the distinct object ids with a live edge into the group. */
  objectsOfGroup: ReadonlyMap<string, ReadonlySet<string>>;
  /** Object id -> the set of group keys it carries — `tagObject`'s "already
   * carries this group" check, regardless of which node the edge names. */
  groupsOfObject: ReadonlyMap<string, ReadonlySet<string>>;
}

const INDEX_CACHE = new WeakMap<Document, TagIndex>();

function buildTagIndex(doc: Document): TagIndex {
  // `doc.nodes` is id-sorted (`withNode`'s own invariant), so the first
  // node pushed into a group is always its lowest id -- the canonical one,
  // with no separate sort needed here.
  const groupsByKey = new Map<string, { name: string; nodeIds: string[] }>();
  for (const n of doc.nodes) {
    if (n.absentSince !== undefined) continue;
    if (!n.id.startsWith(TAG_NODE_PREFIX)) continue;
    const name = asString(fieldValue(n.fields, 'Tag.name'));
    const key = foldTagName(name);
    let g = groupsByKey.get(key);
    if (!g) {
      g = { name, nodeIds: [] };
      groupsByKey.set(key, g);
    }
    g.nodeIds.push(n.id);
  }

  const keyOfNode = new Map<string, string>();
  const groups = new Map<string, TagGroup>();
  for (const [key, g] of groupsByKey) {
    groups.set(key, { key, name: g.name, canonicalId: g.nodeIds[0]!, nodeIds: g.nodeIds });
    for (const id of g.nodeIds) keyOfNode.set(id, key);
  }

  const edgesOfObject = new Map<string, GraphEdge[]>();
  const objectsOfGroup = new Map<string, Set<string>>();
  const groupsOfObject = new Map<string, Set<string>>();
  for (const e of doc.edges) {
    if (e.absentSince !== undefined) continue;
    if (!e.id.startsWith(TAGGED_WITH_EDGE_PREFIX)) continue;
    const key = keyOfNode.get(e.to);
    if (key === undefined) continue; // points at a tombstoned/unknown tag — nothing to index

    let el = edgesOfObject.get(e.from);
    if (!el) {
      el = [];
      edgesOfObject.set(e.from, el);
    }
    el.push(e);

    let os = objectsOfGroup.get(key);
    if (!os) {
      os = new Set();
      objectsOfGroup.set(key, os);
    }
    os.add(e.from);

    let gk = groupsOfObject.get(e.from);
    if (!gk) {
      gk = new Set();
      groupsOfObject.set(e.from, gk);
    }
    gk.add(key);
  }

  return { groups, keyOfNode, edgesOfObject, objectsOfGroup, groupsOfObject };
}

function tagIndex(doc: Document): TagIndex {
  let idx = INDEX_CACHE.get(doc);
  if (!idx) {
    idx = buildTagIndex(doc);
    INDEX_CACHE.set(doc, idx);
  }
  return idx;
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

/** The group `tagId` belongs to, or a `not-a-tag` refusal — every group-wide
 * operation (untag, rename, remove) starts here. */
function requireGroup(doc: Document, tagId: string): TagGroup {
  const idx = tagIndex(doc);
  const key = idx.keyOfNode.get(tagId);
  if (key === undefined) {
    refuse('not-a-tag', `"${tagId}" is not a live Tag in this document`);
  }
  return idx.groups.get(key)!;
}

/** Creates the `Tag` node if `rawName`'s fold matches no live group, or
 * reuses that group's canonical (lowest id) node (decision 5). No
 * containment edge is written for it — `HasTag` reads `from: [root]`, and a
 * root-containment edge is refused outright wherever this document's writes
 * are checked (`cables.ts`'s own header comment). */
function ensureTag(
  doc: Document,
  now: number,
  actor: string,
  rawName: string,
): { doc: Document; tagId: string; name: string; key: string; ops: Op[] } {
  const name = normalizeTagName(rawName);
  const key = foldTagName(name);
  const existing = tagIndex(doc).groups.get(key);
  if (existing) {
    return { doc, tagId: existing.canonicalId, name: existing.name, key, ops: [] };
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
  return { doc: working, tagId, name, key, ops };
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
 * `Tag` if its fold matches no live group. One undoable batch. Refuses an
 * object this document has no live node for, one outside `Taggable`, or one
 * that already carries the group (through any of its nodes, decision 5).
 */
export function tagObject(doc: Document, objectId: string, rawName: string, opts?: Actor): Document {
  requireLiveTaggable(doc, objectId);
  const name = normalizeTagName(rawName);
  const key = foldTagName(name);
  // Checked against `doc`'s OWN index, before `ensureTag` runs: a brand new
  // group cannot already be on `objectId` (nothing pointed at a node that
  // did not exist a moment ago), so this never has to build a second index
  // for the fresh `Document` a new tag's own `add_node` would otherwise
  // produce — the whole reason `tagObject` cost as much as the index build
  // itself even with the index already cached for `doc`.
  const idx = tagIndex(doc);
  const alreadyCarries = idx.groupsOfObject.get(objectId)?.has(key) ?? false;
  if (alreadyCarries) {
    refuse('already-tagged', `"${objectId}" is already tagged "${idx.groups.get(key)!.name}"`);
  }
  const { actor, now } = resolve(opts);
  const ensured = ensureTag(doc, now, actor, rawName);
  const edge = addTaggedWithEdge(ensured.doc, now, actor, objectId, ensured.tagId);
  const batch: Batch = { id: newUlid(now), label: 'tag', ops: [...ensured.ops, ...edge.ops] };
  return withBatch(edge.doc, batch);
}

/**
 * The reverse of `tagObject`: tombstones every live `TaggedWith` edge from
 * `objectId` to `tagId`'s whole group (decision 5 — two duplicate nodes are
 * one tag, so removing it removes both links). The `Tag` node(s) themselves
 * are untouched (decision 7 — a tag outlives its last use). Refuses when
 * `objectId` carries no edge into the group.
 */
export function untagObject(doc: Document, objectId: string, tagId: string, opts?: Actor): Document {
  const group = requireGroup(doc, tagId);
  const edges = (tagIndex(doc).edgesOfObject.get(objectId) ?? []).filter((e) => group.key === tagIndex(doc).keyOfNode.get(e.to));
  if (edges.length === 0) refuse('not-tagged', `"${objectId}" does not carry tag "${group.name}"`);

  const { actor, now } = resolve(opts);
  const edgeIds = new Set(edges.map((e) => e.id));
  const working: Document = { ...doc, edges: doc.edges.map((e) => (edgeIds.has(e.id) ? { ...e, absentSince: now } : e)) };
  const ops: Op[] = edges.map((e): Op => ({ type: 'tombstone', element: e.id, at: now, by: actor }));
  return withBatch(working, { id: newUlid(now), label: 'untag', ops });
}

/**
 * ADR-0059 decision 8 — renames `tagId`'s whole group to `rawName` (decision
 * 5: two duplicate nodes are one tag, so every node in the group takes the
 * new name). Refused by name when another, DIFFERENT group already carries
 * that name (case-insensitively); a rename to a case variant of the group's
 * own current name is not a collision.
 */
export function renameTag(doc: Document, tagId: string, rawName: string, opts?: Actor): Document {
  const group = requireGroup(doc, tagId);
  const name = normalizeTagName(rawName);
  // Not an error, just no change: clicking a chip's name and clicking away
  // with nothing edited must write nothing -- the caller tells the two
  // apart by comparing the returned `Document` to the one it passed in.
  if (name === group.name) return doc;
  const key = foldTagName(name);
  if (key !== group.key) {
    const collision = tagIndex(doc).groups.get(key);
    if (collision) refuse('name-in-use', `a tag named "${name}" already exists`);
  }

  const { actor, now } = resolve(opts);
  let working = doc;
  const ops: Op[] = [];
  for (const nodeId of group.nodeIds) {
    const node = findNode(working, nodeId)!;
    const existing = node.fields['Tag.name'];
    const prov = assertHand(working, { assertedAt: now, assertedBy: actor, supersedes: existing?.prov });
    working = existing !== undefined ? archiveField(prov.doc, nodeId, 'Tag.name', existing) : prov.doc;
    const entry: FieldEntry = { presence: 'set', prov: prov.id, value: text(name) };
    working = replaceNode(working, nodeId, (n) => ({ ...n, fields: { ...n.fields, 'Tag.name': entry } }));
    ops.push({ type: 'set_field', element: nodeId, key: 'Tag.name', presence: 'set', prov: prov.id });
  }
  return withBatch(working, { id: newUlid(now), label: 'rename tag', ops });
}

export interface TagChip {
  edgeId: string;
  tagId: string;
  name: string;
}

/** Every live tag `objectId` carries, one chip per group (decision 5). */
export function tagsOf(doc: Document, objectId: string): TagChip[] {
  const idx = tagIndex(doc);
  const seen = new Set<string>();
  const out: TagChip[] = [];
  for (const e of idx.edgesOfObject.get(objectId) ?? []) {
    const key = idx.keyOfNode.get(e.to);
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    out.push({ edgeId: e.id, tagId: e.to, name: idx.groups.get(key)!.name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface TagSummary {
  id: string;
  name: string;
  count: number;
}

/** Every live tag in the design, its own name and how many DISTINCT objects
 * carry it — a duplicate-name group (decision 5) reads as one row, the
 * canonical (lowest id) node's name, an object counted once even if it
 * somehow holds edges to more than one node in the group. */
export function listTags(doc: Document): TagSummary[] {
  const idx = tagIndex(doc);
  const out: TagSummary[] = [];
  for (const g of idx.groups.values()) {
    out.push({ id: g.canonicalId, name: g.name, count: idx.objectsOfGroup.get(g.key)?.size ?? 0 });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Removes `tagId`'s whole group and every live edge touching any node in it
 * — `cascade.ts`'s own schema-driven cascade, run once per node and merged
 * into one batch, so `TaggedWith` never needs a hand-kept list here. Every
 * tagged object loses the tag; none of them are otherwise touched
 * (decision 7).
 */
export function removeTag(doc: Document, tagId: string, opts?: Actor): Document {
  const group = requireGroup(doc, tagId);
  const { actor, now } = resolve(opts);
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const nodeId of group.nodeIds) {
    const cascaded = cascadeRemoval(doc, nodeId);
    for (const id of cascaded.nodeIds) nodeIds.add(id);
    for (const id of cascaded.edgeIds) edgeIds.add(id);
  }
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
 * Refuses only when every member already carries the group — a partial
 * carry (one port tagged individually before the row existed) is not a
 * refusal, it is the row catching the rest up.
 */
export function tagVlanRow(doc: Document, vlanNodeIds: readonly string[], rawName: string, opts?: Actor): Document {
  if (vlanNodeIds.length === 0) refuse('unknown-reference', 'a VLAN row with no members cannot be tagged');
  for (const id of vlanNodeIds) requireLiveTaggable(doc, id);

  const name = normalizeTagName(rawName);
  const key = foldTagName(name);
  // Fixed by `doc`'s OWN index, before any write: `tagObject`'s own reason
  // for reading `doc` rather than the doc each edge add produces — a member
  // list this short would not show it, but the same one-rebuild-per-node
  // cost is what the index exists to avoid at all.
  const idx = tagIndex(doc);
  const membersAlreadyCarrying = new Set(vlanNodeIds.filter((id) => idx.groupsOfObject.get(id)?.has(key) ?? false));

  const { actor, now } = resolve(opts);
  const ensured = ensureTag(doc, now, actor, rawName);
  let working = ensured.doc;
  const ops: Op[] = [...ensured.ops];
  let addedAny = false;
  for (const id of vlanNodeIds) {
    if (membersAlreadyCarrying.has(id)) continue;
    const edge = addTaggedWithEdge(working, now, actor, id, ensured.tagId);
    working = edge.doc;
    ops.push(...edge.ops);
    addedAny = true;
  }
  if (!addedAny) refuse('already-tagged', `every member of this VLAN already carries "${name}"`);
  return withBatch(working, { id: newUlid(now), label: 'tag VLAN', ops });
}

/** The reverse of `tagVlanRow`: untags every member that carries `tagId`'s
 * group. Refuses when no member carries it. */
export function untagVlanRow(doc: Document, vlanNodeIds: readonly string[], tagId: string, opts?: Actor): Document {
  const group = requireGroup(doc, tagId);
  const idx = tagIndex(doc);
  const { actor, now } = resolve(opts);
  const toTombstone: string[] = [];
  for (const id of vlanNodeIds) {
    for (const e of idx.edgesOfObject.get(id) ?? []) {
      if (idx.keyOfNode.get(e.to) === group.key) toTombstone.push(e.id);
    }
  }
  if (toTombstone.length === 0) refuse('not-tagged', `no member of this VLAN carries tag "${group.name}"`);

  const edgeIds = new Set(toTombstone);
  const working: Document = { ...doc, edges: doc.edges.map((e) => (edgeIds.has(e.id) ? { ...e, absentSince: now } : e)) };
  const ops: Op[] = toTombstone.map((element): Op => ({ type: 'tombstone', element, at: now, by: actor }));
  return withBatch(working, { id: newUlid(now), label: 'untag VLAN', ops });
}

export interface VlanTagChip extends TagChip {
  /** How many of the row's members carry this tag. Equal to `total` when
   * every member does; a partial carry (one member tagged before the row
   * existed) is a row still tagging the rest up to, not a refusal. */
  carriedBy: number;
  total: number;
}

/** The union of every member's tags, one chip per group, each carrying how
 * many of the row's members hold it — the row's own chip reads "2 of 3"
 * rather than plain when the group has not caught up on every member. */
export function tagsOfVlanRow(doc: Document, vlanNodeIds: readonly string[]): VlanTagChip[] {
  const idx = tagIndex(doc);
  const total = vlanNodeIds.length;
  const seen = new Map<string, VlanTagChip>();
  for (const id of vlanNodeIds) {
    for (const chip of tagsOf(doc, id)) {
      const key = foldTagName(chip.name);
      if (seen.has(key)) continue;
      const carriedBy = vlanNodeIds.filter((m) => idx.groupsOfObject.get(m)?.has(key) ?? false).length;
      seen.set(key, { ...chip, carriedBy, total });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
