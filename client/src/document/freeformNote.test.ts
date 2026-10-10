import { describe, expect, it } from 'vitest';

import { duplicateFreeDoc } from '../components/racks/freeActions';
import { noteByline } from '../components/drawing/noteByline';
import { faceplateGlyphRows } from '../print/rackSheet';
import { createLabel, removeFree, setLabel } from './freeform';
import { emptyDocument } from './model';
import { viewOf, type PortView } from './view';

describe('notes pinned to the canvas (schema 0.19)', () => {
  it('adds, edits, copies and removes a note, one undo step each', () => {
    const made = createLabel(emptyDocument(), { text: 'Patch 12 is dead', form: 'note', x: 41, y: 18 });
    expect(made.doc.batches.at(-1)?.label).toBe('add note');
    expect(viewOf(made.doc, []).labels).toEqual([expect.objectContaining({ id: made.id, form: 'note', text: 'Patch 12 is dead', x: 40, y: 20 })]);

    const edited = setLabel(made.doc, made.id, { text: 'Patch 12 is dead\nNew run on order' });
    expect(viewOf(edited, []).labels[0]?.text).toBe('Patch 12 is dead\nNew run on order');

    const copy = duplicateFreeDoc(edited, viewOf(edited, []), [made.id], 24, 24);
    expect(copy.doc.batches.length).toBe(edited.batches.length + 1);
    expect(viewOf(copy.doc, []).labels.map((l) => l.form)).toEqual(['note', 'note']);

    const gone = removeFree(copy.doc, [made.id]);
    expect(viewOf(gone, []).labels.map((l) => l.id)).toEqual(copy.ids);
  });
});

describe("a note's byline", () => {
  it('names who added it and when, from the batch that made it', () => {
    const at = new Date(2026, 9, 9, 15, 0).getTime();
    const made = createLabel(emptyDocument(), { text: 'Ask facilities', form: 'note', x: 0, y: 0, actor: 'acct-km', now: at });
    const note = viewOf(made.doc, []).labels[0]!;
    expect(note.author).toEqual({ actor: 'acct-km', at });
    expect(noteByline(note.author, new Map([['acct-km', 'KM']]), at)).toBe('KM · 9 OCT');
    expect(noteByline(note.author, new Map(), at)).toBe('9 OCT');
    expect(noteByline(note.author, new Map([['acct-km', 'KM']]), new Date(2027, 0, 1).getTime())).toBe('KM · 9 OCT 2026');
  });

  it('has no byline when nobody is on record, and labels never carry one', () => {
    const local = createLabel(emptyDocument(), { text: 'n', form: 'note', x: 0, y: 0 });
    expect(viewOf(local.doc, []).labels[0]!.author).toBeUndefined();
    expect(noteByline(undefined, new Map())).toBeNull();
    const label = createLabel(emptyDocument(), { text: 'l', form: 'text', x: 0, y: 0, actor: 'acct-km', now: 1_700_000_000_000 });
    expect(viewOf(label.doc, []).labels[0]!.author).toBeUndefined();
  });
});

describe('the printed rack sheet', () => {
  const port = (id: string, plate?: { x: number; y: number }): PortView => ({
    id,
    label: id,
    connector: 'rj45',
    row: 0,
    column: 0,
    uplink: false,
    role: null,
    face: 'front',
    passThroughId: null,
    cable: null,
    ...(plate ? { plate } : {}),
  });

  it('prints dragged ports in the order they were arranged: top half, bottom half, left to right', () => {
    const rows = faceplateGlyphRows([port('a', { x: 900, y: 200 }), port('b', { x: 100, y: 800 }), port('c', { x: 100, y: 100 })]);
    expect(rows.map((r) => r.map((p) => p.id))).toEqual([['c', 'a'], ['b']]);
  });
});
