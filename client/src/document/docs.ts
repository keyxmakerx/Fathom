// ADR-0061 round 7: a doc is a `Doc` node (title, Markdown body, how it arrived) hung off the root
// like a Tag. What it is about is a `DocOn` edge to a Device, PassiveNode, PhysicalPort, Cable or
// Rack, or its `model` field (it shows on every thing of that model), or neither (design-wide).
// Links are `DocLink` nodes under it. A pasted body goes through the gate BEFORE it reaches this
// module (`engine.redactText`, ADR-0053 §6); typed text is stored as typed. Who and when come from
// the provenance of the title and body fields, as a note's do.

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
  identifier,
  kebab,
  parseNodeId,
  replaceNode,
  requireFieldName,
  text,
  token,
  uint,
  withBatch,
  withEdge,
  withNode,
  type Batch,
  type Document,
  type FieldEntry,
  type NodeKind,
  type Op,
} from './model';
import type { CanonValue } from './canon';
import { newUlid } from './ulid';

interface Actor {
  actor?: string;
  now?: number;
}

function resolve(opts: Actor | undefined): { actor: string; now: number } {
  return { actor: opts?.actor ?? LOCAL_ACTOR, now: opts?.now ?? Date.now() };
}

/** `Docable` in `schema/schema.yaml`. */
const DOCABLE_KINDS: readonly NodeKind[] = ['Device', 'PassiveNode', 'PhysicalPort', 'Cable', 'Rack'];

export const MAX_TITLE = 120;
export const MAX_BODY = 50_000;
export const MAX_LINKS = 20;
export const MAX_FILES = 20;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_URL = 2048;

const DOC_PREFIX = `${kebab('Doc')}:`;

export type DocRefusalCode =
  | 'empty-title'
  | 'too-long'
  | 'too-many-links'
  | 'too-many-files'
  | 'bad-file'
  | 'bad-url'
  | 'not-docable'
  | 'not-a-doc';

export class DocRefusalError extends Error {
  readonly code: DocRefusalCode;
  constructor(code: DocRefusalCode, message: string) {
    super(message);
    this.name = 'DocRefusalError';
    this.code = code;
  }
}

export type DocHow = 'typed' | 'pasted';

export type DocTarget = { kind: 'thing'; id: string } | { kind: 'model'; model: string } | { kind: 'design' };

export interface DocLinkView {
  id: string;
  title: string;
  url: string;
}

export type FileMedia = 'text' | 'pdf' | 'image';
export type FileChecked = 'clean' | 'removed' | 'unread';

export interface DocFileView {
  id: string;
  name: string;
  size: number;
  media: FileMedia;
  checked: FileChecked;
  removed: number;
  fileId: string;
  sha256: string;
}

export interface DocView {
  id: string;
  title: string;
  body: string;
  how: DocHow;
  /** The catalogue model it is about, in `modelKey` form. */
  model: string | null;
  /** The thing it is about; null for a model doc or a design-wide doc. */
  ownerId: string | null;
  /** It was about a thing that has since been removed. */
  ownerGone: boolean;
  links: DocLinkView[];
  files: DocFileView[];
  /** Who last changed the title or body, and when. */
  who: string;
  when: number;
  /** Set by `docsOf`: shown on this thing because of its model, not its own. */
  onModel?: boolean;
}

/** `Doc.model` is an Identifier: printable ASCII, no space. A catalogue model name is mapped, never refused. */
export function modelKey(model: string): string {
  return model.trim().replace(/[^\x21-\x7e]+/g, '-');
}

function fieldValue(fields: Readonly<Record<string, FieldEntry>>, key: string): CanonValue | undefined {
  const e = fields[key];
  return e && e.presence === 'set' ? e.value : undefined;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function cleanTitle(raw: string, what: string): string {
  const t = raw.replace(/\s+/g, ' ').trim();
  if (t.length === 0) throw new DocRefusalError('empty-title', `${what} needs some words.`);
  if (t.length > MAX_TITLE) throw new DocRefusalError('too-long', `${what} is longer than ${MAX_TITLE} characters.`);
  return t;
}

function cleanBody(raw: string): string {
  if (raw.length > MAX_BODY) throw new DocRefusalError('too-long', `A doc body is at most ${MAX_BODY} characters.`);
  return raw;
}

/** http and https only, shown by host. Anything else (javascript:, data:, file:, relative) is not a link. */
export function safeUrl(raw: string): { href: string; host: string } | null {
  const t = raw.trim();
  if (t.length === 0 || t.length > MAX_URL) return null;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username !== '' || u.password !== '') return null;
  return { href: u.href, host: u.host };
}

function liveDocNode(doc: Document, docId: string) {
  const n = findNode(doc, docId);
  if (!n || n.absentSince !== undefined || !docId.startsWith(DOC_PREFIX)) {
    throw new DocRefusalError('not-a-doc', `"${docId}" is not a live doc in this design.`);
  }
  return n;
}

function newField(doc: Document, now: number, actor: string, node: string, key: string, value: CanonValue) {
  requireFieldName(key);
  const prov = assertHand(doc, { assertedAt: now, assertedBy: actor });
  const entry: FieldEntry = { presence: 'set', prov: prov.id, value };
  const op: Op = {
    type: 'set_field',
    element: node,
    key,
    presence: 'set',
    prov: prov.id,
  };
  return { doc: prov.doc, entry, op };
}

/** Adds a doc about `target`. One undoable batch. */
export function addDoc(
  doc: Document,
  target: DocTarget,
  input: { title: string; body: string; how: DocHow },
  opts?: Actor,
): { doc: Document; id: string } {
  const title = cleanTitle(input.title, 'A doc');
  const body = cleanBody(input.body);
  if (target.kind === 'thing') {
    const owner = findNode(doc, target.id);
    if (!owner || owner.absentSince !== undefined)
      throw new UnknownReferenceError(target.id, 'a live object in this design');
    if (!DOCABLE_KINDS.includes(parseNodeId(target.id).kind)) {
      throw new DocRefusalError('not-docable', 'Docs attach to a device, port, cable, rack, model or the design.');
    }
  }
  const { actor, now } = resolve(opts);
  const ops: Op[] = [];
  const existence = assertHand(doc, { assertedAt: now, assertedBy: actor });
  let working = existence.doc;
  const id = formatNodeId('Doc', newUlid(now));
  const fields: Record<string, FieldEntry> = {};
  const values: [string, CanonValue][] = [
    ['Doc.title', text(title)],
    ['Doc.body', text(body)],
    ['Doc.how', token(input.how)],
  ];
  if (target.kind === 'model') values.push(['Doc.model', identifier(modelKey(target.model))]);
  const fieldOps: Op[] = [];
  for (const [key, value] of values) {
    const f = newField(working, now, actor, id, key, value);
    working = f.doc;
    fields[key] = f.entry;
    fieldOps.push(f.op);
  }
  working = withNode(working, { id, existence: existence.id, fields });
  ops.push({ type: 'add_node', node: id, prov: existence.id }, ...fieldOps);
  if (target.kind === 'thing') {
    const prov = assertHand(working, { assertedAt: now, assertedBy: actor });
    const edgeId = formatEdgeId('DocOn', newUlid(now));
    working = withEdge(prov.doc, {
      id: edgeId,
      from: id,
      to: target.id,
      prov: prov.id,
      fields: {},
    });
    ops.push({
      type: 'add_edge',
      edge: edgeId,
      from: id,
      to: target.id,
      prov: prov.id,
    });
  }
  const batch: Batch = { id: newUlid(now), label: 'add doc', ops };
  return { doc: withBatch(working, batch), id };
}

/** Changes a doc's title, body or both. Returns the same Document when nothing differs. */
export function editDoc(
  doc: Document,
  docId: string,
  patch: { title?: string; body?: string; how?: DocHow },
  opts?: Actor,
): Document {
  const node = liveDocNode(doc, docId);
  const next: [string, CanonValue][] = [];
  if (patch.title !== undefined) {
    const t = cleanTitle(patch.title, 'A doc');
    if (t !== str(fieldValue(node.fields, 'Doc.title'))) next.push(['Doc.title', text(t)]);
  }
  if (patch.body !== undefined) {
    const b = cleanBody(patch.body);
    if (b !== str(fieldValue(node.fields, 'Doc.body'))) next.push(['Doc.body', text(b)]);
  }
  // A body that has had a paste in it stays pasted.
  if (patch.how === 'pasted' && fieldValue(node.fields, 'Doc.how') !== 'pasted')
    next.push(['Doc.how', token('pasted')]);
  if (next.length === 0) return doc;
  const { actor, now } = resolve(opts);
  let working = doc;
  const ops: Op[] = [];
  for (const [key, value] of next) {
    const existing = findNode(working, docId)!.fields[key];
    const prov = assertHand(working, {
      assertedAt: now,
      assertedBy: actor,
      supersedes: existing?.prov,
    });
    working = existing !== undefined ? archiveField(prov.doc, docId, key, existing) : prov.doc;
    const entry: FieldEntry = { presence: 'set', prov: prov.id, value };
    working = replaceNode(working, docId, (n) => ({
      ...n,
      fields: { ...n.fields, [key]: entry },
    }));
    ops.push({
      type: 'set_field',
      element: docId,
      key,
      presence: 'set',
      prov: prov.id,
    });
  }
  return withBatch(working, { id: newUlid(now), label: 'edit doc', ops });
}

/** Tombstones the doc, its links and its edges together. */
export function removeDoc(doc: Document, docId: string, opts?: Actor): Document {
  liveDocNode(doc, docId);
  const { actor, now } = resolve(opts);
  const links = edgesOut(doc, docId, 'HasDocLink');
  const on = edgesOut(doc, docId, 'DocOn');
  const files = edgesOut(doc, docId, 'HasDocFile');
  const nodeIds = new Set([docId, ...links.map((e) => e.to), ...files.map((e) => e.to)]);
  const edgeIds = new Set([...links, ...files, ...on].map((e) => e.id));
  const working: Document = {
    ...doc,
    nodes: doc.nodes.map((n) => (nodeIds.has(n.id) ? { ...n, absentSince: now } : n)),
    edges: doc.edges.map((e) => (edgeIds.has(e.id) ? { ...e, absentSince: now } : e)),
  };
  const ops: Op[] = [...nodeIds, ...edgeIds].map((element): Op => ({ type: 'tombstone', element, at: now, by: actor }));
  return withBatch(working, { id: newUlid(now), label: 'remove doc', ops });
}

/** Adds a link to a doc. The URL must be http or https; the title may be empty and then shows the host. */
export function addDocLink(
  doc: Document,
  docId: string,
  input: { title: string; url: string },
  opts?: Actor,
): Document {
  liveDocNode(doc, docId);
  const safe = safeUrl(input.url);
  if (!safe) throw new DocRefusalError('bad-url', 'A link must be a web address starting with http:// or https://.');
  if (edgesOut(doc, docId, 'HasDocLink').length >= MAX_LINKS) {
    throw new DocRefusalError('too-many-links', `A doc has at most ${MAX_LINKS} links.`);
  }
  const title = cleanTitle(input.title.trim() === '' ? safe.host : input.title, 'A link');
  const { actor, now } = resolve(opts);
  const existence = assertHand(doc, { assertedAt: now, assertedBy: actor });
  let working = existence.doc;
  const id = formatNodeId('DocLink', newUlid(now));
  const fields: Record<string, FieldEntry> = {};
  const fieldOps: Op[] = [];
  for (const [key, value] of [
    ['DocLink.title', text(title)],
    ['DocLink.url', text(safe.href)],
  ] as [string, CanonValue][]) {
    const f = newField(working, now, actor, id, key, value);
    working = f.doc;
    fields[key] = f.entry;
    fieldOps.push(f.op);
  }
  working = withNode(working, { id, existence: existence.id, fields });
  const edgeProv = assertHand(working, { assertedAt: now, assertedBy: actor });
  const edgeId = formatEdgeId('HasDocLink', newUlid(now));
  working = withEdge(edgeProv.doc, {
    id: edgeId,
    from: docId,
    to: id,
    prov: edgeProv.id,
    fields: {},
  });
  const ops: Op[] = [
    { type: 'add_node', node: id, prov: existence.id },
    ...fieldOps,
    { type: 'add_edge', edge: edgeId, from: docId, to: id, prov: edgeProv.id },
  ];
  return withBatch(working, { id: newUlid(now), label: 'add link', ops });
}

export function removeDocLink(doc: Document, linkId: string, opts?: Actor): Document {
  const edge = edgesIn(doc, linkId, 'HasDocLink')[0];
  if (!edge) throw new UnknownReferenceError(linkId, 'a link on a doc in this design');
  const { actor, now } = resolve(opts);
  const working: Document = {
    ...doc,
    nodes: doc.nodes.map((n) => (n.id === linkId ? { ...n, absentSince: now } : n)),
    edges: doc.edges.map((e) => (e.id === edge.id ? { ...e, absentSince: now } : e)),
  };
  const ops: Op[] = [
    { type: 'tombstone', element: linkId, at: now, by: actor },
    { type: 'tombstone', element: edge.id, at: now, by: actor },
  ];
  return withBatch(working, { id: newUlid(now), label: 'remove link', ops });
}

/** Adds a stored file to a doc. The bytes are already with the server; this records what the person sees. */
export function addDocFile(
  doc: Document,
  docId: string,
  input: {
    name: string;
    size: number;
    media: FileMedia;
    checked: FileChecked;
    removed: number;
    fileId: string;
    sha256: string;
  },
  opts?: Actor,
): Document {
  liveDocNode(doc, docId);
  if (!/^[0-9a-f]{32}$/.test(input.fileId) || !/^[0-9a-f]{64}$/.test(input.sha256))
    throw new DocRefusalError('bad-file', 'That file was not stored properly.');
  if (!Number.isInteger(input.size) || input.size < 1 || input.size > MAX_FILE_BYTES)
    throw new DocRefusalError('bad-file', 'A file is at most 25 MB.');
  if (edgesOut(doc, docId, 'HasDocFile').length >= MAX_FILES)
    throw new DocRefusalError('too-many-files', `A doc has at most ${MAX_FILES} files.`);
  // No direction-changing characters: they can make a name read as another extension.
  const name = cleanTitle(input.name.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ''), 'A file name');
  const { actor, now } = resolve(opts);
  const existence = assertHand(doc, { assertedAt: now, assertedBy: actor });
  let working = existence.doc;
  const id = formatNodeId('DocFile', newUlid(now));
  const fields: Record<string, FieldEntry> = {};
  const fieldOps: Op[] = [];
  const values: [string, CanonValue][] = [
    ['DocFile.name', text(name)],
    ['DocFile.size', uint(input.size, 32)],
    ['DocFile.media', token(input.media)],
    ['DocFile.checked', token(input.checked)],
    ['DocFile.file_id', identifier(input.fileId)],
    ['DocFile.sha256', text(input.sha256)],
  ];
  if (input.checked === 'removed') values.push(['DocFile.removed', uint(input.removed, 32)]);
  for (const [key, value] of values) {
    const f = newField(working, now, actor, id, key, value);
    working = f.doc;
    fields[key] = f.entry;
    fieldOps.push(f.op);
  }
  working = withNode(working, { id, existence: existence.id, fields });
  const edgeProv = assertHand(working, { assertedAt: now, assertedBy: actor });
  const edgeId = formatEdgeId('HasDocFile', newUlid(now));
  working = withEdge(edgeProv.doc, { id: edgeId, from: docId, to: id, prov: edgeProv.id, fields: {} });
  const ops: Op[] = [
    { type: 'add_node', node: id, prov: existence.id },
    ...fieldOps,
    { type: 'add_edge', edge: edgeId, from: docId, to: id, prov: edgeProv.id },
  ];
  return withBatch(working, { id: newUlid(now), label: 'add file', ops });
}

export function removeDocFile(doc: Document, fileNodeId: string, opts?: Actor): Document {
  const edge = edgesIn(doc, fileNodeId, 'HasDocFile')[0];
  if (!edge) throw new UnknownReferenceError(fileNodeId, 'a file on a doc in this design');
  const { actor, now } = resolve(opts);
  const working: Document = {
    ...doc,
    nodes: doc.nodes.map((n) => (n.id === fileNodeId ? { ...n, absentSince: now } : n)),
    edges: doc.edges.map((e) => (e.id === edge.id ? { ...e, absentSince: now } : e)),
  };
  const ops: Op[] = [
    { type: 'tombstone', element: fileNodeId, at: now, by: actor },
    { type: 'tombstone', element: edge.id, at: now, by: actor },
  ];
  return withBatch(working, { id: newUlid(now), label: 'remove file', ops });
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0;
}

function readDoc(doc: Document, id: string): DocView | undefined {
  const node = findNode(doc, id);
  if (!node || node.absentSince !== undefined) return undefined;
  const provOf = (key: string) => {
    const e = node.fields[key];
    return e ? doc.provenance.find((p) => p.id === e.prov) : undefined;
  };
  const latest = [provOf('Doc.title'), provOf('Doc.body')]
    .filter((p): p is NonNullable<typeof p> => p !== undefined)
    .sort((a, b) => b.assertedAt - a.assertedAt)[0];
  const model = str(fieldValue(node.fields, 'Doc.model'));
  const on = edgesOut(doc, id, 'DocOn')[0];
  const owner = on ? findNode(doc, on.to) : undefined;
  const links: DocLinkView[] = [];
  for (const e of edgesOut(doc, id, 'HasDocLink')) {
    const ln = findNode(doc, e.to);
    if (!ln || ln.absentSince !== undefined) continue;
    links.push({
      id: ln.id,
      title: str(fieldValue(ln.fields, 'DocLink.title')),
      url: str(fieldValue(ln.fields, 'DocLink.url')),
    });
  }
  const files: DocFileView[] = [];
  for (const e of edgesOut(doc, id, 'HasDocFile')) {
    const fn = findNode(doc, e.to);
    if (!fn || fn.absentSince !== undefined) continue;
    const media = str(fieldValue(fn.fields, 'DocFile.media'));
    const checked = str(fieldValue(fn.fields, 'DocFile.checked'));
    files.push({
      id: fn.id,
      name: str(fieldValue(fn.fields, 'DocFile.name')),
      size: num(fieldValue(fn.fields, 'DocFile.size')),
      media: media === 'pdf' || media === 'image' ? media : 'text',
      checked: checked === 'clean' || checked === 'removed' ? checked : 'unread',
      removed: num(fieldValue(fn.fields, 'DocFile.removed')),
      fileId: str(fieldValue(fn.fields, 'DocFile.file_id')),
      sha256: str(fieldValue(fn.fields, 'DocFile.sha256')),
    });
  }
  return {
    id,
    title: str(fieldValue(node.fields, 'Doc.title')),
    body: str(fieldValue(node.fields, 'Doc.body')),
    how: fieldValue(node.fields, 'Doc.how') === 'pasted' ? 'pasted' : 'typed',
    model: model === '' ? null : model,
    ownerId: on ? on.to : null,
    ownerGone: on !== undefined && (!owner || owner.absentSince !== undefined),
    links,
    files,
    who: latest?.assertedBy ?? LOCAL_ACTOR,
    when: latest?.assertedAt ?? 0,
  };
}

export function docView(doc: Document, id: string): DocView | undefined {
  return id.startsWith(DOC_PREFIX) ? readDoc(doc, id) : undefined;
}

function allDocViews(doc: Document): DocView[] {
  const out: DocView[] = [];
  for (const n of doc.nodes) {
    if (n.absentSince !== undefined || !n.id.startsWith(DOC_PREFIX)) continue;
    const v = readDoc(doc, n.id);
    if (v) out.push(v);
  }
  return out;
}

/** The docs on a thing: its own first, then those on its model marked `onModel`. */
export function docsOf(doc: Document, ownerId: string, model?: string | null): DocView[] {
  const own = edgesIn(doc, ownerId, 'DocOn')
    .map((e) => readDoc(doc, e.from))
    .filter((v): v is DocView => v !== undefined);
  const key = model ? modelKey(model) : '';
  if (key === '') return own;
  const onModel = allDocViews(doc)
    .filter((v) => v.model === key)
    .map((v) => ({ ...v, onModel: true }));
  return [...own, ...onModel];
}

/** Design-wide docs, plus any whose thing has been removed (so none is lost from view). */
export function designDocs(doc: Document): DocView[] {
  return allDocViews(doc).filter((v) => v.model === null && (v.ownerId === null || v.ownerGone));
}

/** Docs on a catalogue model, for the design's list (a model with no thing left still shows). */
export function modelDocs(doc: Document): DocView[] {
  return allDocViews(doc).filter((v) => v.model !== null);
}

/** A short name for what a doc is about: the hostname or label, else the kind. */
export function thingLabel(doc: Document, id: string): string {
  const n = findNode(doc, id);
  if (!n || n.absentSince !== undefined) return 'a removed item';
  for (const key of ['Device.hostname', 'Rack.label', 'PhysicalPort.label', 'Cable.label', 'PassiveNode.label']) {
    const v = str(fieldValue(n.fields, key));
    if (v !== '') return v;
  }
  return parseNodeId(id).kind;
}

/** Every doc in the design, for the Docs list. */
export function allDocs(doc: Document): DocView[] {
  return allDocViews(doc);
}
