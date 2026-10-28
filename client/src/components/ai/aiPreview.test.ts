import { describe, expect, it } from 'vitest';

import type { AiIdea } from '../../api/ai';
import { fitCard, removeCard, setCardField } from '../../document/cards';
import { changeOf } from '../../document/change';
import { createRack, placeChassis } from '../../document/commands';
import { setRackField } from '../../document/edit';
import { edgesIn, edgesOut, emptyDocument, findNode, formatNodeId, type Document } from '../../document/model';
import { newUlid } from '../../document/ulid';
import { buildCanon } from '../checks/checksModel';
import { createAiPreviewStore, drawnPreview, previewMarks, PREVIEW_WORDS } from './aiPreview';

const D1 = 'device:01ARZ3NDEKTSV4RRFFQ69G5FAV';
const D2 = 'device:01ARZ3NDEKTSV4RRFFQ69G5FAW';
const P1 = 'port:01ARZ3NDEKTSV4RRFFQ69G5FAX';
const P2 = 'port:01ARZ3NDEKTSV4RRFFQ69G5FAY';
const C1 = 'cable:01ARZ3NDEKTSV4RRFFQ69G5FAZ';

describe("an AI idea's proposed change on the canvas", () => {
  it('outlines what it changes, greys what it removes, cuts a cable it removes, and dashes a link between things there', () => {
    const marks = previewMarks('I1', {
      changes: [D1],
      removes: [D2, C1],
      adds: [{ kind: 'Device', name: 'new' }],
      links: [
        { kind: 'Cable', from: P1, to: P2 },
        { kind: 'Cable', from: 'new', to: P2 },
      ],
    });
    expect(marks.map((m) => [m.kind, m.keys.join(','), m.word, m.removed === true])).toEqual([
      ['touch', D1, PREVIEW_WORDS.change, false],
      ['touch', D2, PREVIEW_WORDS.remove, true],
      ['cut-cable', C1, PREVIEW_WORDS.remove, true],
      ['add-cable', `${P1},${P2}`, PREVIEW_WORDS.add, false],
    ]);
    expect(new Set(marks.map((m) => m.stepId)).size).toBe(marks.length);
  });

  it('shows one idea at a time, focused on what it touches, and nothing for steps only', () => {
    const store = createAiPreviewStore();
    let told = 0;
    store.subscribe(() => (told += 1));
    const idea = { id: 'I1', preview: { changes: [D1], removes: [], adds: [], links: [] } } as unknown as AiIdea;
    store.show(idea);
    expect(store.get().ideaId).toBe('I1');
    expect([...(store.get().focus ?? [])]).toEqual([D1]);
    store.show({ ...idea, preview: null });
    expect(store.get().ideaId).toBeNull();
    store.show(null);
    expect(store.get().marks).toEqual([]);
    expect(told).toBe(3);
  });
});

const T0 = 1_700_000_000_000;
const ME = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MODEL = {
  vendor: 'juniper',
  model: 'SRX1500',
  rackUnits: 1,
  reviewedBy: 'reviewer',
  source: { cite: 'cite', readOn: '2026-09-14' },
  psuSlots: [],
  faceplates: [{ face: 'front' as const, portCount: 1, ports: [{ kind: 'RJ45', number: 0, uplink: false, row: 'single' as const, column: 0, groupGapBefore: false }] }],
};

function rack(): { doc: Document; rackId: string } {
  const premisesId = formatNodeId('Premises', newUlid(T0));
  const empty: Document = { ...emptyDocument(), nodes: [{ id: premisesId, existence: newUlid(T0), fields: {} }] };
  const doc = createRack(empty, premisesId, { label: 'Rack 1', heightU: 12, unitNumbering: 'ascending', actor: ME, now: T0 + 1 });
  return { doc, rackId: doc.nodes.find((n) => n.id !== premisesId)!.id };
}

describe('an AI idea drawn with its change made', () => {
  const idea = { id: 'I1', preview: { changes: [], removes: [], adds: [{ kind: 'Chassis', name: 'c_juniper' }], links: [] } } as unknown as AiIdea;

  it('draws a chassis it adds in its rack, outlined as an add, and leaves the design itself alone', () => {
    const { doc, rackId } = rack();
    const after = placeChassis(doc, rackId, MODEL, 4, 'front', { actor: ME, now: T0 + 2 });
    const drawn = drawnPreview(doc, idea, changeOf(doc, after))!;
    const chassisId = edgesIn(drawn.doc, rackId, 'MountedIn')[0].from;
    expect(findNode(doc, chassisId)).toBeUndefined();
    const deviceId = drawn.canon(chassisId);
    expect(deviceId).toMatch(/^device:/);
    const added = drawn.marks.filter((m) => m.word === PREVIEW_WORDS.add).flatMap((m) => m.keys);
    expect(added).toContain(deviceId);
    expect(drawn.marks.every((m) => m.word === PREVIEW_WORDS.add)).toBe(true);
  });

  it('outlines what it changes and keeps what it removes drawn, greyed', () => {
    const { doc, rackId } = rack();
    const changed = setRackField(doc, rackId, 'label', 'Rack One', { actor: ME, now: T0 + 2 });
    const change = changeOf(doc, changed);
    const drawn = drawnPreview(doc, idea, change)!;
    expect(drawn.marks.map((m) => [m.keys.join(','), m.word])).toEqual([[rackId, PREVIEW_WORDS.change]]);

    const removing = { ...change, batch: { ...change.batch, ops: [{ type: 'tombstone' as const, element: rackId, at: T0 + 3, by: ME }] }, provenance: [], values: [] };
    const gone = drawnPreview(doc, idea, removing)!;
    expect(findNode(gone.doc, rackId)?.absentSince).toBeUndefined();
    expect(gone.marks.map((m) => [m.keys.join(','), m.word, m.removed])).toEqual([[rackId, PREVIEW_WORDS.remove, true]]);
  });

  it('is nothing when the change no longer fits the design, and the store then keeps the outlines', () => {
    const { doc, rackId } = rack();
    const after = placeChassis(doc, rackId, MODEL, 4, 'front', { actor: ME, now: T0 + 2 });
    const change = changeOf(doc, after);
    expect(drawnPreview(after, idea, change)).toBeNull();

    const store = createAiPreviewStore();
    store.show(idea, drawnPreview(doc, idea, change));
    expect(store.get().doc).not.toBeNull();
    store.show(idea, null);
    expect(store.get().doc).toBeNull();
    expect(store.get().canon).toBeNull();
  });
});

describe('an AI idea that changes what is inside a device', () => {
  const idea = { id: 'I1', preview: { changes: [], removes: [], adds: [], links: [] } } as unknown as AiIdea;
  const placed = () => {
    const { doc, rackId } = rack();
    const after = placeChassis(doc, rackId, MODEL, 4, 'front', { actor: ME, now: T0 + 2 });
    const chassisId = edgesIn(after, rackId, 'MountedIn')[0].from;
    return { doc: after, chassisId, deviceId: buildCanon(after)(chassisId) };
  };
  const cardIn = (doc: Document, chassisId: string): string => edgesOut(doc, chassisId, 'HasCard')[0].to;

  it('tags the device AI ADDS INSIDE for a card it fits, outlines the card, and never calls the device new', () => {
    const { doc, chassisId, deviceId } = placed();
    const after = fitCard(doc, chassisId, '0', { name: 'line card' }, { actor: ME, now: T0 + 3 });
    const drawn = drawnPreview(doc, idea, changeOf(doc, after))!;
    expect(drawn.marks.map((m) => [m.keys.join(','), m.word])).toEqual([[deviceId, PREVIEW_WORDS.addInside]]);
    expect([...drawn.parts]).toContain(cardIn(after, chassisId));
  });

  it('tags a card it changes AI CHANGES INSIDE, and one it takes out AI REMOVES INSIDE without greying the device', () => {
    const { doc: placedDoc, chassisId, deviceId } = placed();
    const doc = fitCard(placedDoc, chassisId, '0', { name: 'line card' }, { actor: ME, now: T0 + 3 });
    const cardId = cardIn(doc, chassisId);

    const renamed = drawnPreview(doc, idea, changeOf(doc, setCardField(doc, cardId, 'name', 'uplinks', { actor: ME, now: T0 + 4 })))!;
    expect(renamed.marks.map((m) => [m.keys.join(','), m.word])).toEqual([[deviceId, PREVIEW_WORDS.changeInside]]);
    expect([...renamed.parts]).toEqual([cardId]);

    const out = drawnPreview(doc, idea, changeOf(doc, removeCard(doc, cardId, { actor: ME, now: T0 + 4 })))!;
    expect(out.marks.map((m) => [m.keys.join(','), m.word, m.removed === true])).toEqual([[deviceId, PREVIEW_WORDS.removeInside, false]]);
    expect(out.parts.has(cardId)).toBe(true);
  });

  it('marks a new device whole, without an INSIDE tag or an outline on each of its ports', () => {
    const { doc, rackId } = rack();
    const after = placeChassis(doc, rackId, MODEL, 4, 'front', { actor: ME, now: T0 + 2 });
    const drawn = drawnPreview(doc, idea, changeOf(doc, after))!;
    expect(drawn.marks.every((m) => m.word === PREVIEW_WORDS.add)).toBe(true);
    expect(drawn.parts.size).toBe(0);
  });

  it('finds the device for a part the idea names before its change is built', () => {
    const { doc: placedDoc, chassisId, deviceId } = placed();
    const doc = fitCard(placedDoc, chassisId, '0', { name: 'line card' }, { actor: ME, now: T0 + 3 });
    const cardId = cardIn(doc, chassisId);
    const store = createAiPreviewStore();
    store.show({ id: 'I2', preview: { changes: [cardId], removes: [], adds: [], links: [] } } as unknown as AiIdea, null, buildCanon(doc));
    expect(store.get().marks.map((m) => [m.keys.join(','), m.word])).toEqual([[deviceId, PREVIEW_WORDS.changeInside]]);
    expect([...store.get().parts]).toEqual([cardId]);
  });
});
