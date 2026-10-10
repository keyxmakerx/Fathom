import { describe, expect, it } from 'vitest';

import { createRack, placeChassis } from '../../document/commands';
import { setDeviceField, setRackField } from '../../document/edit';
import { edgesIn, emptyDocument, formatNodeId, type Document } from '../../document/model';
import { newUlid } from '../../document/ulid';
import {
  canvasThingsOf,
  changesSentence,
  collectChangesSince,
  parseSeen,
  sinceWords,
  whoWords,
  type SeenMarker,
} from './changesSince';

const T0 = new Date(2026, 8, 1, 9, 0, 0).getTime();
const ME = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SAM = '01BX5ZZKBKACTAV9WEVGEMMVRY';
const ANA = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

const MODEL = {
  vendor: 'juniper',
  model: 'EX4300-48P',
  rackUnits: 1,
  reviewedBy: 'reviewer',
  source: { cite: 'cite', readOn: '2026-09-14' },
  psuSlots: [],
  faceplates: [{ face: 'front' as const, portCount: 1, ports: [{ kind: 'RJ45', number: 0, uplink: false, row: 'single' as const, column: 0, groupGapBefore: false }] }],
};

function world() {
  const premisesId = formatNodeId('Premises', newUlid(T0));
  const empty: Document = { ...emptyDocument(), nodes: [{ id: premisesId, existence: newUlid(T0), fields: {} }] };
  const withRack = createRack(empty, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', actor: ME, now: T0 + 1 });
  const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
  const doc = placeChassis(withRack, rackId, MODEL, 4, 'front', { actor: ME, now: T0 + 2 });
  const chassisId = edgesIn(doc, rackId, 'MountedIn')[0]!.from;
  const deviceId = edgesIn(doc, chassisId, 'HasChassis')[0]!.from;
  const seen: SeenMarker = { batchId: doc.batches[doc.batches.length - 1]!.id, at: T0 + 10 };
  return { doc, rackId, chassisId, deviceId, seen };
}

describe('collecting what changed', () => {
  it('finds nothing the first time a design is opened', () => {
    const { doc } = world();
    expect(collectChangesSince(doc, ME, null)).toBeNull();
  });

  it('finds nothing when only you changed things, or nothing changed', () => {
    const { doc, deviceId, seen } = world();
    expect(collectChangesSince(doc, ME, seen)).toBeNull();
    const mine = setDeviceField(doc, deviceId, 'hostname', 'edge-1', { actor: ME, now: T0 + 100 });
    expect(collectChangesSince(mine, ME, seen)).toBeNull();
  });

  it('counts other people\'s batches and maps them to the chassis and rack they touched', () => {
    const { doc, deviceId, rackId, chassisId, seen } = world();
    const one = setDeviceField(doc, deviceId, 'hostname', 'edge-1', { actor: SAM, now: T0 + 100 });
    const two = setRackField(one, rackId, 'label', 'R9', { actor: SAM, now: T0 + 200 });
    const three = setDeviceField(two, deviceId, 'role', 'switch', { actor: ANA, now: T0 + 300 });
    const mine = setDeviceField(three, deviceId, 'hostname', 'mine', { actor: ME, now: T0 + 400 });
    const found = collectChangesSince(mine, ME, seen)!;
    expect(found.count).toBe(3);
    expect(found.authors).toEqual([
      { account: SAM, count: 2 },
      { account: ANA, count: 1 },
    ]);
    expect(found.things).toEqual([
      { id: chassisId, kind: 'chassis' },
      { id: rackId, kind: 'rack' },
    ]);
    expect(found.since).toBe(seen.at);
    expect(found.lastBatchId).toBe(three.batches[three.batches.length - 1]!.id);
  });

  it('falls back to time when the marker\'s batch is gone', () => {
    const { doc, deviceId, seen } = world();
    const before = setDeviceField(doc, deviceId, 'hostname', 'old', { actor: SAM, now: T0 + 5 });
    const after = setDeviceField(before, deviceId, 'hostname', 'new', { actor: SAM, now: T0 + 50 });
    const found = collectChangesSince(after, ME, { batchId: 'gone', at: seen.at })!;
    expect(found.count).toBe(1);
  });

  it('leaves out a thing that has since been removed', () => {
    const { doc, rackId, chassisId } = world();
    expect(canvasThingsOf(doc, chassisId)).toEqual([{ id: chassisId, kind: 'chassis' }]);
    expect(canvasThingsOf(doc, rackId)).toEqual([{ id: rackId, kind: 'rack' }]);
    expect(canvasThingsOf(doc, 'chassis:01ARZ3NDEKTSV4RRFFQ69G5FAV')).toEqual([]);
  });

  it('resolves a port to its box', () => {
    const { doc, chassisId } = world();
    const port = doc.edges.find((e) => e.from === chassisId && e.id.startsWith('has-port:'))!;
    expect(canvasThingsOf(doc, port.to)).toEqual([{ id: chassisId, kind: 'chassis' }]);
  });
});

describe('the words', () => {
  const names = (m: Record<string, string>) => (a: string) => m[a] ?? null;
  const authors = (...accounts: string[]) => accounts.map((account) => ({ account }));

  it('names who, however many', () => {
    const n = names({ a: 'Sam', b: 'Ana', c: 'Bo', d: 'Cy' });
    expect(whoWords(authors('a'), n)).toBe('Sam');
    expect(whoWords(authors('a', 'b'), n)).toBe('Sam and Ana');
    expect(whoWords(authors('a', 'b', 'c'), n)).toBe('Sam, Ana and Bo');
    expect(whoWords(authors('a', 'b', 'c', 'd'), n)).toBe('Sam, Ana and 2 others');
  });

  it('says someone when a name is not known', () => {
    const n = names({ a: 'Sam' });
    expect(whoWords(authors('x'), n)).toBe('someone');
    expect(whoWords(authors('a', 'x'), n)).toBe('Sam and someone');
    expect(whoWords(authors('x', 'y'), n)).toBe('2 people');
  });

  it('says since when', () => {
    const now = new Date(2026, 8, 17, 16, 0).getTime(); // a Thursday
    expect(sinceWords(new Date(2026, 8, 17, 14, 20).getTime(), now)).toBe('today at 14:20');
    expect(sinceWords(new Date(2026, 8, 16, 9, 5).getTime(), now)).toBe('yesterday at 09:05');
    expect(sinceWords(new Date(2026, 8, 15, 9, 5).getTime(), now)).toBe('Tuesday');
    expect(sinceWords(new Date(2026, 8, 1, 9, 5).getTime(), now)).toBe('1 September');
  });

  it('writes the sentence', () => {
    const now = new Date(2026, 8, 17, 16, 0).getTime();
    const found = {
      count: 5,
      authors: [
        { account: 'a', count: 3 },
        { account: 'b', count: 2 },
      ],
      things: [],
      since: new Date(2026, 8, 15, 9, 0).getTime(),
      lastBatchId: 'x',
    };
    expect(changesSentence(found, names({ a: 'Sam', b: 'Ana' }), now)).toBe('5 changes by Sam and Ana since Tuesday');
    expect(changesSentence({ ...found, count: 1, authors: [{ account: 'a', count: 1 }] }, names({ a: 'Sam' }), now)).toBe('1 change by Sam since Tuesday');
  });
});

describe('the seen marker', () => {
  it('keeps what is valid and drops the rest', () => {
    expect(parseSeen({ batchId: 'b', at: 5 })).toEqual({ batchId: 'b', at: 5 });
    expect(parseSeen({ batchId: '', at: 5 })).toBeNull();
    expect(parseSeen({ batchId: 'b', at: 'x' })).toBeNull();
    expect(parseSeen(null)).toBeNull();
  });
});
