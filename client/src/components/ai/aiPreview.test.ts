import { describe, expect, it } from 'vitest';

import type { AiIdea } from '../../api/ai';
import { createAiPreviewStore, previewMarks, PREVIEW_WORDS } from './aiPreview';

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
