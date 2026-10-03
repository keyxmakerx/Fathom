// The live document's state, pure (ADR-0063 §5, §6, §10): the document at the
// last server version (`confirmed`), the changes made here and not yet
// echoed back (`pending`), and what the person sees (`visible`, the pending
// changes replayed on `confirmed`). No network, no React.

import { applyChange, ChangeError, onTheWire, type Change } from './change';
import type { CanonValue } from './canon';
import {
  archiveField,
  assertHand,
  findEdge,
  findNode,
  withBatch,
  type Batch,
  type Document,
  type FieldPresence,
  type Op,
} from './model';
import { newUlid } from './ulid';

export interface LiveState {
  confirmed: Document;
  /** The server version `confirmed` is at. */
  version: number;
  pending: Change[];
  visible: Document;
}

export function openLive(doc: Document, version: number): LiveState {
  return { confirmed: doc, version, pending: [], visible: doc };
}

/** Replays `pending` on `confirmed`; a change that no longer applies is dropped. */
export function rebase(confirmed: Document, pending: readonly Change[]): { visible: Document; kept: Change[]; dropped: Change[] } {
  let visible = confirmed;
  const kept: Change[] = [];
  const dropped: Change[] = [];
  const have = new Set(confirmed.batches.map((b) => b.id));
  for (const change of pending) {
    if (have.has(change.batch.id)) continue; // already in: a whole save carried it
    try {
      visible = applyChange(visible, change);
      kept.push(change);
    } catch (e) {
      if (!(e instanceof ChangeError)) throw e;
      dropped.push(change);
    }
  }
  return { visible, kept, dropped };
}

// ---------------------------------------------------------------------------
// Local edits

function unnamedProvenance(batches: readonly Batch[]): Set<string> {
  const named = new Set<string>();
  for (const b of batches) for (const op of b.ops) if ('prov' in op) named.add(op.prov);
  return named;
}

function writtenValue(doc: Document, element: string, key: string, prov: string): CanonValue {
  const live = (findNode(doc, element) ?? findEdge(doc, element))?.fields[key];
  if (live !== undefined && live.prov === prov && live.value !== undefined) return live.value;
  const archived = doc.history.find((h) => h.element === element && h.field === key)?.entries.find((e) => e.prov === prov);
  if (archived?.value !== undefined) return archived.value;
  throw new ChangeError('missing-value', `no value for ${key} on ${element}`);
}

/** The changes `next` adds to `state.visible`: one per batch `visible` lacks.
 * When `next` is not built on `visible` (a remote change landed while the
 * edit was made) they are applied to `visible` instead, and may refuse. */
export function localEdit(state: LiveState, next: Document): { state: LiveState; changes: Change[] } {
  const have = new Set(state.visible.batches.map((b) => b.id));
  const appended = next.batches.filter((b) => !have.has(b.id));

  if (appended.length === 0) {
    // A comment attached to a batch still pending rides on its change.
    const text = new Map(next.batches.map((b) => [b.id, b.comment]));
    let touched = false;
    const pending = state.pending.map((c) => {
      const comment = text.get(c.batch.id);
      if (comment === undefined || comment === c.batch.comment) return c;
      touched = true;
      return { ...c, batch: { ...c.batch, comment } };
    });
    if (!touched) return { state, changes: [] };
    const visible = rebase(state.confirmed, pending);
    return { state: { ...state, pending: visible.kept, visible: visible.visible }, changes: [] };
  }

  const known = new Set(state.visible.provenance.map((p) => p.id));
  const fresh = next.provenance.filter((p) => !known.has(p.id));
  const claimed = new Set<string>();
  const changes: Change[] = appended.map((batch) => {
    const named = unnamedProvenance([batch]);
    const mine = fresh.filter((p) => named.has(p.id) && !claimed.has(p.id));
    mine.forEach((p) => claimed.add(p.id));
    const values: CanonValue[] = [];
    for (const op of batch.ops) {
      if (op.type === 'set_field' && op.presence === 'set') values.push(writtenValue(next, op.element, op.key, op.prov));
    }
    return { batch, provenance: mine.map(onTheWire), values };
  });

  const exact =
    next.batches.length === state.visible.batches.length + appended.length &&
    state.visible.batches.every((b, i) => next.batches[i]?.id === b.id);
  let visible = next;
  if (!exact) {
    visible = state.visible;
    for (const c of changes) visible = applyChange(visible, c); // throws ChangeError
  }
  const sendable = changes.filter((c) => c.batch.ops.length > 0); // the server refuses an empty batch
  return { state: { ...state, pending: [...state.pending, ...sendable], visible }, changes: sendable };
}

// ---------------------------------------------------------------------------
// What the server sends

export interface Overwrite {
  element: string;
  key: string;
  /** The account that wrote over it. */
  by: string;
  /** What this person had written. */
  mine: { presence: FieldPresence | 'unknown'; value?: CanonValue };
  /** The version of `visible` the notice is about, for ordering only. */
  at: number;
}

export interface Remote {
  state: LiveState;
  /** The server's version is not the next one: reopen from `state.version`. */
  gap: boolean;
  /** Its own change echoed back. */
  echoed: boolean;
  dropped: Change[];
  overwrites: Overwrite[];
}

export interface Context {
  me: string;
  /** When this sitting began, ms. */
  sittingStart: number;
  now: number;
}

export const OVERWRITE_WINDOW_MS = 10 * 60 * 1000;

function fieldEntry(doc: Document, element: string, key: string) {
  return (findNode(doc, element) ?? findEdge(doc, element))?.fields[key];
}

/** Fields of `change` that replaced a value this person wrote in this sitting,
 * within the window, and still win in `after`. */
export function overwritesBy(before: Document, after: Document, change: Change, ctx: Context): Overwrite[] {
  const out: Overwrite[] = [];
  const authors = new Map(change.provenance.map((p) => [p.id, p.assertedBy]));
  const seen = new Set<string>();
  for (const op of change.batch.ops) {
    if (op.type !== 'set_field') continue;
    const id = `${op.element}\n${op.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const was = fieldEntry(before, op.element, op.key);
    if (was === undefined) continue;
    const mine = before.provenance.find((p) => p.id === was.prov);
    if (!mine || mine.assertedBy !== ctx.me) continue;
    if (mine.assertedAt < ctx.sittingStart || ctx.now - mine.assertedAt > OVERWRITE_WINDOW_MS) continue;
    const now = fieldEntry(after, op.element, op.key);
    if (now !== undefined && now.prov === was.prov) continue; // mine still stands
    if (now !== undefined && !authors.has(now.prov)) continue; // someone else's again, not this change
    const by = authors.get(op.prov);
    if (by === undefined || by === ctx.me) continue;
    out.push({ element: op.element, key: op.key, by, mine: { presence: was.presence, value: was.value }, at: ctx.now });
  }
  return out;
}

/** A change the server has put at `version`. Throws `ChangeError` when it
 * cannot apply to `confirmed`: the caller reopens the design. */
export function applyRemote(state: LiveState, change: Change, version: number, ctx: Context): Remote {
  const none = { dropped: [], overwrites: [] };
  if (version <= state.version) return { state, gap: false, echoed: false, ...none };
  if (version !== state.version + 1) return { state, gap: true, echoed: false, ...none };

  const confirmed = applyChange(state.confirmed, change);
  const echoAt = state.pending.findIndex((p) => p.batch.id === change.batch.id);
  if (echoAt >= 0) {
    const pending = state.pending.filter((_, i) => i !== echoAt);
    if (echoAt === 0) {
      return { state: { ...state, confirmed, version, pending }, gap: false, echoed: true, ...none };
    }
    const r = rebase(confirmed, pending);
    return { state: { confirmed, version, pending: r.kept, visible: r.visible }, gap: false, echoed: true, dropped: r.dropped, overwrites: [] };
  }

  const r = rebase(confirmed, state.pending);
  return {
    state: { confirmed, version, pending: r.kept, visible: r.visible },
    gap: false,
    echoed: false,
    dropped: r.dropped,
    overwrites: overwritesBy(state.visible, r.visible, change, ctx),
  };
}

/** The server refused the pending change `batchId`: drop it, and whatever
 * depended on it. */
export function applyRefusal(state: LiveState, batchId: string): { state: LiveState; dropped: Change[] } {
  const first = state.pending.find((p) => p.batch.id === batchId);
  if (!first) return { state, dropped: [] };
  const r = rebase(
    state.confirmed,
    state.pending.filter((p) => p.batch.id !== batchId),
  );
  return { state: { ...state, pending: r.kept, visible: r.visible }, dropped: [first, ...r.dropped] };
}

/** A whole save landed at `version` (type 2): the design as reopened, with
 * the pending changes replayed on it. */
export function applyReload(state: LiveState, doc: Document, version: number): { state: LiveState; dropped: Change[] } {
  const r = rebase(doc, state.pending);
  return { state: { confirmed: doc, version, pending: r.kept, visible: r.visible }, dropped: r.dropped };
}

// ---------------------------------------------------------------------------
// Put mine back

/** A new, ordinary change setting the field back to what this person had
 * written. `undefined` when the element is gone. */
export function putMineBack(doc: Document, o: Overwrite, opts: { actor: string; now: number }): Document | undefined {
  const holder = findNode(doc, o.element) ?? findEdge(doc, o.element);
  if (!holder) return undefined;
  const existing = holder.fields[o.key];
  const prov = assertHand(doc, { assertedAt: opts.now, assertedBy: opts.actor, supersedes: existing?.prov });
  let working = existing !== undefined ? archiveField(prov.doc, o.element, o.key, existing) : prov.doc;
  const presence = o.mine.presence;
  const fields = { ...holder.fields };
  if (presence === 'set') fields[o.key] = { presence: 'set', prov: prov.id, value: o.mine.value };
  else if (presence === 'absent') fields[o.key] = { presence: 'absent', prov: prov.id };
  else delete fields[o.key];
  working = findNode(doc, o.element)
    ? { ...working, nodes: working.nodes.map((n) => (n.id === o.element ? { ...n, fields } : n)) }
    : { ...working, edges: working.edges.map((e) => (e.id === o.element ? { ...e, fields } : e)) };
  const op: Op = { type: 'set_field', element: o.element, key: o.key, presence, prov: prov.id };
  return withBatch(working, { id: newUlid(opts.now), label: 'put mine back', ops: [op] });
}

// ---------------------------------------------------------------------------
// Sentences

export function fieldWords(key: string): string {
  const name = key.includes('.') ? key.slice(key.indexOf('.') + 1) : key;
  return name.replace(/_/g, ' ');
}

export function overwriteSentence(o: Overwrite, who: string | undefined): string {
  return `${who ?? 'Someone'} changed ${fieldWords(o.key)} just after you.`;
}

export function droppedSentence(dropped: readonly Change[]): string {
  if (dropped.length === 0) return '';
  if (dropped.length === 1) return `Your change "${dropped[0].batch.label}" no longer fit what others did, so it was left out.`;
  return `${dropped.length} of your changes no longer fit what others did, so they were left out.`;
}

/** What an undo or redo left alone because someone else changed it since. */
export function skippedSentence(skipped: readonly { key: string }[], nothingDone: boolean): string {
  const words = [...new Set(skipped.map((s) => fieldWords(s.key)))];
  const list = words.length <= 2 ? words.join(' and ') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  const many = words.length > 1;
  if (nothingDone) return `Nothing was undone: ${list} ${many ? 'were' : 'was'} changed by someone else since.`;
  return `${list[0].toUpperCase()}${list.slice(1)} ${many ? 'were' : 'was'} left as ${many ? 'they are' : 'it is'}, because someone else changed ${many ? 'them' : 'it'} since.`;
}
