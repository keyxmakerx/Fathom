import { describe, expect, it } from 'vitest';

import type { CorrectionView } from '../../api/corrections';
import { findNode } from '../../document/model';
import { undo } from '../../document/undo';
import { viewOf } from '../../document/view';
import { acceptedLabel, applyCorrection, dayOf, dismissedLabel, targetIsALiveCable, whyNotApplicable } from './corrections';
import { historyOf } from './kinds';
import { lastTracedOf } from './cablePath';
import { notesOf } from '../../document/notes';
import { smallEstate } from './testFixture';

const e = smallEstate();
const cableId = e.cables['C-10412']!;

const correction = (over: Partial<CorrectionView>): CorrectionView => ({
  id: '01JCORRECTION000000000000AA',
  cable: cableId,
  kind: 'label',
  text: 'PP1-04',
  sender: 'acct-ann',
  senderName: 'Ann',
  createdAt: Date.UTC(2026, 9, 3, 15, 30),
  state: 'open',
  decidedBy: null,
  decidedAt: null,
  version: 1,
  ...over,
});

const labelOf = (doc: typeof e.doc) => viewOf(doc, []).cables.find((c) => c.id === cableId)?.label;

describe('accepting a correction', () => {
  it('a label correction changes the label in ONE batch that names the sender', () => {
    const next = applyCorrection(e.doc, correction({}), { actor: 'acct-draw' });
    expect(labelOf(next)).toBe('PP1-04');
    expect(next.batches.length).toBe(e.doc.batches.length + 1);
    expect(next.batches[next.batches.length - 1]!.label).toBe("accepted Ann's correction");
    const lines = historyOf(next, [cableId]);
    expect(lines[0]).toMatchObject({ label: "accepted Ann's correction", who: 'acct-draw' });
  });

  it('a traced stamp records the day it was walked as Last traced', () => {
    expect(lastTracedOf(e.doc, cableId)).toBeNull();
    const next = applyCorrection(e.doc, correction({ kind: 'traced', text: '' }), { actor: 'acct-draw' });
    expect(lastTracedOf(next, cableId)).toBe('2026-10-03');
    expect(next.batches[next.batches.length - 1]!.label).toBe("accepted Ann's correction");
  });

  it('a not-here report is added as a note on the cable', () => {
    const next = applyCorrection(e.doc, correction({ kind: 'not_here', text: 'Behind the blanking plate' }), { actor: 'acct-draw' });
    expect(notesOf(next, cableId).map((n) => n.text)).toEqual(['Reported not here: Behind the blanking plate']);
    expect(next.batches.length).toBe(e.doc.batches.length + 1);
  });

  it('is one undo step', () => {
    const next = applyCorrection(e.doc, correction({}), { actor: 'acct-draw' });
    const last = next.batches[next.batches.length - 1]!;
    const back = undo(next, last.id, { actor: 'acct-draw', now: Date.now() });
    expect(labelOf(back)).toBe(labelOf(e.doc));
  });

  it('refuses a cable that is gone, and leaves the document alone', () => {
    expect(whyNotApplicable(e.doc, correction({}))).toBeNull();
    expect(whyNotApplicable(e.doc, correction({ cable: 'cable:01JNOSUCHCABLE0000000000AA' }))).toMatch(/no longer/);
    expect(() => applyCorrection(e.doc, correction({ cable: 'cable:01JNOSUCHCABLE0000000000AA' }))).toThrow();
    expect(findNode(e.doc, cableId)).toBeDefined();
  });

  it('puts no sender name in the note, so a surname like Key cannot trip a later save', () => {
    const next = applyCorrection(e.doc, correction({ kind: 'not_here', text: 'In B3', senderName: 'Key Secret' }), { actor: 'acct-draw' });
    expect(notesOf(next, cableId).map((n) => n.text)).toEqual(['Reported not here: In B3']);
    expect(next.batches[next.batches.length - 1]!.label).toBe("accepted Key Secret's correction");
  });

  it('refuses a target that is not a Cable, even a live one', () => {
    const rack = e.doc.nodes.find((n) => n.id.startsWith('rack:'))!.id;
    expect(targetIsALiveCable(e.doc, rack)).toBe(false);
    expect(whyNotApplicable(e.doc, correction({ cable: rack }))).toMatch(/no longer/);
    expect(() => applyCorrection(e.doc, correction({ cable: rack, kind: 'not_here', text: 'x' }))).toThrow();
  });

  it('words the two decisions', () => {
    expect(acceptedLabel({ senderName: 'Ann' })).toBe("accepted Ann's correction");
    expect(dismissedLabel({ senderName: 'Ann' })).toBe("dismissed Ann's correction");
    expect(dayOf(Date.UTC(2026, 0, 2, 23, 59))).toBe('2026-01-02');
  });
});
