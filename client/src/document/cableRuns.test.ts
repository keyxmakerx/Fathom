import { describe, expect, it } from 'vitest';

import { addCableRun, addCableTie, cableRunsOf, moveCableTie, removeCableRun, removeCableTie } from './cableRuns';
import { disconnect } from './cables';
import { addEdge, addNode, begin, finish } from './freeform';
import { emptyDocument, findNode, text, token, uint, type Document } from './model';
import { undo } from './undo';

const NOW = 1_700_000_000_000;
const OPTS = { now: NOW, actor: 'test' };

function fixture(): { doc: Document; rackId: string; cables: string[] } {
  const b = begin(emptyDocument(), OPTS);
  const premises = addNode(b, 'Premises', {});
  const rackId = addNode(b, 'Rack', { 'Rack.label': text('R1'), 'Rack.height_u': uint(42, 8), 'Rack.unit_numbering': token('ascending') });
  addEdge(b, 'HasRack', premises, rackId);
  const cables = [addNode(b, 'Cable', {}), addNode(b, 'Cable', {})];
  return { doc: finish(b, 'fixture'), rackId, cables };
}

const live = (doc: Document, id: string) => findNode(doc, id)?.absentSince === undefined;

describe('cable runs', () => {
  it('adds a lacing bar to a rack and reads it back', () => {
    const { doc, rackId } = fixture();
    const next = addCableRun(doc, rackId, { form: 'lacing_bar', side: 'left', ...OPTS });
    const runs = cableRunsOf(next, rackId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ hostId: rackId, form: 'lacing_bar', side: 'left', label: null, ties: [] });
  });

  it('refuses a host that is not a rack or wall', () => {
    const { doc, cables } = fixture();
    expect(() => addCableRun(doc, cables[0]!, { form: 'tray', side: 'top', ...OPTS })).toThrow();
  });

  it('clips a tie onto a run, slides it, and unclips it', () => {
    const { doc, rackId, cables } = fixture();
    let d = addCableRun(doc, rackId, { form: 'tray', side: 'top', ...OPTS });
    const runId = cableRunsOf(d, rackId)[0]!.id;
    d = addCableTie(d, runId, { at: 250, cableIds: cables, ...OPTS });
    let tie = cableRunsOf(d, rackId)[0]!.ties[0]!;
    expect(tie.at).toBe(250);
    expect(tie.cableIds.sort()).toEqual([...cables].sort());
    d = moveCableTie(d, tie.id, 1700, OPTS);
    tie = cableRunsOf(d, rackId)[0]!.ties[0]!;
    expect(tie.at).toBe(1000);
    d = removeCableTie(d, tie.id, OPTS);
    expect(cableRunsOf(d, rackId)[0]!.ties).toEqual([]);
    expect(cables.every((c) => live(d, c))).toBe(true);
  });

  it('takes its ties when the run comes off, and leaves the cables', () => {
    const { doc, rackId, cables } = fixture();
    let d = addCableRun(doc, rackId, { form: 'tray', side: 'top', ...OPTS });
    const runId = cableRunsOf(d, rackId)[0]!.id;
    d = addCableTie(d, runId, { at: 500, cableIds: cables, ...OPTS });
    const tieId = cableRunsOf(d, rackId)[0]!.ties[0]!.id;
    d = removeCableRun(d, runId, OPTS);
    expect(cableRunsOf(d, rackId)).toEqual([]);
    expect(live(d, tieId)).toBe(false);
    expect(cables.every((c) => live(d, c))).toBe(true);
  });

  it('a removed cable lets go of its tie, and the tie stays', () => {
    const { doc, rackId, cables } = fixture();
    let d = addCableRun(doc, rackId, { form: 'tray', side: 'top', ...OPTS });
    const runId = cableRunsOf(d, rackId)[0]!.id;
    d = addCableTie(d, runId, { at: 500, cableIds: cables, ...OPTS });
    d = disconnect(d, cables[0]!, OPTS);
    expect(cableRunsOf(d, rackId)[0]!.ties[0]!.cableIds).toEqual([cables[1]]);
  });

  it('undoes a tie move', () => {
    const { doc, rackId, cables } = fixture();
    let d = addCableRun(doc, rackId, { form: 'tray', side: 'top', ...OPTS });
    d = addCableTie(d, cableRunsOf(d, rackId)[0]!.id, { at: 100, cableIds: cables, ...OPTS });
    const tieId = cableRunsOf(d, rackId)[0]!.ties[0]!.id;
    d = moveCableTie(d, tieId, 900, OPTS);
    d = undo(d, d.batches[d.batches.length - 1]!.id, OPTS);
    expect(cableRunsOf(d, rackId)[0]!.ties[0]!.at).toBe(100);
  });
});
