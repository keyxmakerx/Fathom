// "What changed while you were away": which batches other people made since this person last
// saw the design, the canvas things they touched, and the sentence that says so. Pure, apart
// from the two small browser-local records at the bottom (never a document field).

import { LOCAL_ACTOR, edgesIn, edgesOut, findEdge, findNode, isNodeOfKind, type Batch, type Document, type Op } from '../../document/model';
import { batchActor } from '../../document/undo';

/** A thing the canvas draws, by its element id, and what selecting it means. */
export interface ChangedThing {
  id: string;
  /** The selection kind, or `null` for a thing the canvas shows but cannot select (a wall or floor). */
  kind: 'rack' | 'chassis' | 'cable' | 'shelf' | 'occupant' | 'fixture' | 'label' | 'line' | null;
}

export interface ChangesSince {
  /** Batches by other people since the marker. */
  count: number;
  /** Each person who made some, most changes first. */
  authors: Array<{ account: string; count: number }>;
  /** The canvas things they touched that still exist, in the order they were touched. */
  things: ChangedThing[];
  /** When this person last saw the design (ms), or the earliest change when that is not known. */
  since: number;
  /** The newest batch, which dismissing marks as seen. */
  lastBatchId: string;
}

export interface SeenMarker {
  batchId: string;
  /** When it was recorded, in ms. */
  at: number;
}

function opElements(op: Op): string[] {
  switch (op.type) {
    case 'add_node':
      return [op.node];
    case 'add_edge':
      return [op.edge, op.from];
    case 'set_field':
    case 'tombstone':
    case 'revive':
      return [op.element];
  }
}

/** When a batch was made: its newest provenance record or tombstone. `null` if it carries neither. */
export function batchTime(doc: Document, batch: Batch): number | null {
  const at = new Map<string, number>();
  for (const p of doc.provenance) at.set(p.id, p.assertedAt);
  let newest: number | null = null;
  for (const op of batch.ops) {
    const t = op.type === 'tombstone' || op.type === 'revive' ? op.at : at.get(op.prov);
    if (t !== undefined && (newest === null || t > newest)) newest = t;
  }
  return newest;
}

const alive = (doc: Document, id: string) => {
  const n = findNode(doc, id);
  return n !== undefined && n.absentSince === undefined;
};

/** The canvas things an element belongs to: a device is its chassis, a port is the box it is on. */
export function canvasThingsOf(doc: Document, element: string, depth = 0): ChangedThing[] {
  if (depth > 3) return [];
  const edge = findEdge(doc, element);
  if (edge !== undefined) return canvasThingsOf(doc, edge.from, depth + 1);
  if (!alive(doc, element)) return [];
  const own = (kind: ChangedThing['kind']): ChangedThing[] => [{ id: element, kind }];
  if (isNodeOfKind(element, 'Chassis')) return own('chassis');
  if (isNodeOfKind(element, 'Rack')) return own('rack');
  if (isNodeOfKind(element, 'Cable')) return own('cable');
  if (isNodeOfKind(element, 'Label')) return own('label');
  if (isNodeOfKind(element, 'Line')) return own('line');
  if (isNodeOfKind(element, 'Surface')) return own(null);
  if (isNodeOfKind(element, 'PassiveNode')) {
    if (edgesOut(doc, element, 'SitsOn').length > 0) return own('occupant');
    if (edgesOut(doc, element, 'FixedTo').length > 0) return own('fixture');
    return own('shelf');
  }
  if (isNodeOfKind(element, 'Device')) return edgesOut(doc, element, 'HasChassis').flatMap((e) => canvasThingsOf(doc, e.to, depth + 1));
  if (isNodeOfKind(element, 'PhysicalPort')) return edgesIn(doc, element, 'HasPort').flatMap((e) => canvasThingsOf(doc, e.from, depth + 1));
  if (isNodeOfKind(element, 'PowerSupply')) return edgesIn(doc, element, 'FittedIn').flatMap((e) => canvasThingsOf(doc, e.from, depth + 1));
  return [];
}

/**
 * What other people changed since `seen`. `null` when there is no marker (the first time a person opens
 * a design), or when nothing by anyone else came after it. The marker is found by its batch; if that
 * batch is gone, by time.
 */
export function collectChangesSince(doc: Document, me: string | null, seen: SeenMarker | null): ChangesSince | null {
  if (seen === null) return null;
  const at = doc.batches.findIndex((b) => b.id === seen.batchId);
  const fresh =
    at >= 0
      ? doc.batches.slice(at + 1)
      : doc.batches.filter((b) => {
          const t = batchTime(doc, b);
          return t !== null && t > seen.at;
        });
  const counts = new Map<string, number>();
  const things = new Map<string, ChangedThing>();
  let count = 0;
  let earliest: number | null = null;
  let lastBatchId = '';
  for (const batch of fresh) {
    const actor = batchActor(doc, batch);
    if (actor === undefined || actor === LOCAL_ACTOR || actor === me) continue;
    count += 1;
    lastBatchId = batch.id;
    counts.set(actor, (counts.get(actor) ?? 0) + 1);
    const t = batchTime(doc, batch);
    if (t !== null && (earliest === null || t < earliest)) earliest = t;
    for (const element of batch.ops.flatMap(opElements)) {
      for (const thing of canvasThingsOf(doc, element)) if (!things.has(thing.id)) things.set(thing.id, thing);
    }
  }
  if (count === 0) return null;
  const authors = [...counts].map(([account, n]) => ({ account, count: n })).sort((a, b) => b.count - a.count);
  return { count, authors, things: [...things.values()], since: seen.at > 0 ? seen.at : (earliest ?? 0), lastBatchId };
}

// ---------------------------------------------------------------------------
// Words

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "today at 14:20", "yesterday at 09:05", "Tuesday" (within the last week), else "12 September". */
export function sinceWords(since: number, now: number): string {
  const then = new Date(since);
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(then)) / 86_400_000);
  const time = `${String(then.getHours()).padStart(2, '0')}:${String(then.getMinutes()).padStart(2, '0')}`;
  if (days <= 0) return `today at ${time}`;
  if (days === 1) return `yesterday at ${time}`;
  if (days < 7) return DAYS[then.getDay()]!;
  return `${then.getDate()} ${MONTHS[then.getMonth()]}`;
}

/** "Sam", "Sam and Ana", "Sam, Ana and Bo", "Sam, Ana and 2 others". Unknown names read as "someone" or "2 people". */
export function whoWords(authors: ReadonlyArray<{ account: string }>, nameOf: (account: string) => string | null): string {
  const named: string[] = [];
  for (const a of authors) {
    const name = nameOf(a.account)?.trim();
    if (name) named.push(name);
  }
  const unnamed = authors.length - named.length;
  const items = unnamed === 0 ? named : [...named, unnamed === 1 ? 'someone' : `${unnamed} people`];
  if (items.length === 0) return 'someone';
  if (items.length > 3) {
    const others = authors.length - 2;
    return `${named.slice(0, 2).join(', ')} and ${others} others`;
  }
  return items.length === 1 ? items[0]! : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "2 changes by Sam since Tuesday". */
export function changesSentence(c: ChangesSince, nameOf: (account: string) => string | null, now: number): string {
  const noun = c.count === 1 ? 'change' : 'changes';
  return `${c.count} ${noun} by ${whoWords(c.authors, nameOf)} since ${sinceWords(c.since, now)}`;
}

// ---------------------------------------------------------------------------
// Kept in this browser, per person and design, beside the resume record.

export function seenKey(accountId: string | null, designId: string | undefined): string {
  return `fathom.seen.${accountId ?? 'anon'}.${designId ?? 'unsaved'}`;
}

export function parseSeen(raw: unknown): SeenMarker | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.batchId !== 'string' || r.batchId === '' || typeof r.at !== 'number' || !Number.isFinite(r.at)) return null;
  return { batchId: r.batchId, at: r.at };
}

export function loadSeen(accountId: string | null, designId: string | undefined): SeenMarker | null {
  try {
    const raw = localStorage.getItem(seenKey(accountId, designId));
    if (raw != null) return parseSeen(JSON.parse(raw));
  } catch {
    // storage unavailable or damaged: treat as the first visit
  }
  return null;
}

/** Records that the design was seen up to its newest batch. Best effort; an empty design records nothing. */
export function saveSeen(accountId: string | null, designId: string | undefined, doc: Document, now: number): void {
  const last = doc.batches[doc.batches.length - 1];
  if (designId == null || last === undefined) return;
  try {
    localStorage.setItem(seenKey(accountId, designId), JSON.stringify({ batchId: last.id, at: now } satisfies SeenMarker));
  } catch {
    // not remembered
  }
}

// People heard on this design, by account, so a later visit can name someone who is not online now.

const namesKey = (accountId: string | null, designId: string | undefined) => `fathom.names.${accountId ?? 'anon'}.${designId ?? 'unsaved'}`;

export function loadNames(accountId: string | null, designId: string | undefined): Map<string, string> {
  try {
    const raw = localStorage.getItem(namesKey(accountId, designId));
    const parsed: unknown = raw == null ? null : JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      return new Map(Object.entries(parsed as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));
    }
  } catch {
    // none known
  }
  return new Map();
}

export function rememberNames(accountId: string | null, designId: string | undefined, people: ReadonlyArray<{ account: string; name: string }>): void {
  if (designId == null || people.length === 0) return;
  try {
    const known = loadNames(accountId, designId);
    let changed = false;
    for (const p of people) {
      if (p.name !== '' && known.get(p.account) !== p.name) {
        known.set(p.account, p.name);
        changed = true;
      }
    }
    if (changed) localStorage.setItem(namesKey(accountId, designId), JSON.stringify(Object.fromEntries(known)));
  } catch {
    // not remembered
  }
}
