import { describe, expect, it } from 'vitest';

import { createRack, removeChassis } from './commands';
import { describeRestore, describeSave, outlineIds, outlineSelectors } from './historyDiff';
import { emptyDocument, formatNodeId, type Document } from './model';
import { newUlid } from './ulid';

const NOW = 1_700_000_000_000;
const ACTOR = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function base(): { doc: Document; premisesId: string } {
  const premisesId = formatNodeId('Premises', newUlid(NOW));
  const doc: Document = {
    ...emptyDocument(),
    nodes: [
      { id: premisesId, existence: newUlid(NOW), fields: { 'Premises.label': { presence: 'set', prov: newUlid(NOW), value: 'HQ' } } },
    ],
  };
  return { doc, premisesId };
}

describe('describeSave', () => {
  it('names the first save', () => {
    expect(describeSave(null, emptyDocument()).summary).toBe('Design created');
  });

  it('reads what a save added off the new batches and outlines it', () => {
    const { doc, premisesId } = base();
    const next = createRack(doc, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', actor: ACTOR, now: NOW });
    const rackId = next.nodes.find((n) => n.id !== premisesId)!.id;
    const change = describeSave(doc, next);
    expect(change.summary).toBe(next.batches[next.batches.length - 1]!.label);
    expect(change.changed).toContain(rackId);
  });

  it('says a save with no new batch changed nothing drawn', () => {
    const { doc } = base();
    expect(describeSave(doc, doc)).toEqual({ summary: 'Saved with no drawn change', changed: [] });
  });

  it('folds a long list to two labels and a count', () => {
    const { doc, premisesId } = base();
    let next = doc;
    for (const label of ['R1', 'R2', 'R3', 'R4']) {
      next = createRack(next, premisesId, { label, heightU: 42, unitNumbering: 'ascending', actor: ACTOR, now: NOW });
    }
    expect(describeSave(doc, next).summary).toMatch(/; \+2 more$/);
  });
});

describe('describeRestore', () => {
  it('names what comes back and what goes', () => {
    const { doc, premisesId } = base();
    const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', actor: ACTOR, now: NOW });
    expect(describeRestore(withRack, doc)).toBe('This will remove 1 rack.');
    expect(describeRestore(doc, withRack)).toBe('This will bring back 1 rack.');
    expect(describeRestore(doc, doc)).toBe('Nothing drawn differs from now.');
  });
});

describe('outline', () => {
  it('quotes ids into selectors for nodes and cables', () => {
    expect(outlineSelectors(['x:1'])).toContain('[data-id="chassis:x:1"]');
    expect(outlineSelectors(['x:1'])).toContain('[data-testid="rf__edge-x:1"]');
  });

  it('keeps ids it is given', () => {
    const { doc } = base();
    void removeChassis;
    expect(outlineIds(doc, ['a'])).toEqual(['a']);
  });
});
