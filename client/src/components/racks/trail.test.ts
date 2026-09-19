import { describe, expect, it } from 'vitest';

import { createRack } from '../../document/commands';
import { setRackField } from '../../document/edit';
import { LOCAL_ACTOR, emptyDocument, formatNodeId, type Document } from '../../document/model';
import { newUlid } from '../../document/ulid';
import { redo, undo } from '../../document/undo';
import { redoable, trailRows, whoLabel } from './trail';

const NOW = 1_700_000_000_000;
const ACTOR_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ACTOR_B = '01ARZ3NDEKTSV4RRFFQ69G5FBV';

function docWithRack(actor: string, now: number): { doc: Document; rackId: string } {
  const premisesId = formatNodeId('Premises', newUlid(now));
  const base: Document = {
    ...emptyDocument(),
    nodes: [{ id: premisesId, existence: newUlid(now), fields: {} }],
  };
  const withRack = createRack(base, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', actor, now });
  const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
  return { doc: withRack, rackId };
}

describe('whoLabel', () => {
  it('names the signed-in account by its own address', () => {
    expect(whoLabel(ACTOR_A, ACTOR_A, 'maria@example.com')).toBe('maria@example.com');
  });

  it('gives anyone else a short id, never their address', () => {
    expect(whoLabel(ACTOR_B, ACTOR_A, 'maria@example.com')).toBe(ACTOR_B.slice(0, 8));
  });

  it('reads a LOCAL-stamped or mixed batch as local', () => {
    expect(whoLabel(LOCAL_ACTOR, ACTOR_A, 'maria@example.com')).toBe('local');
    expect(whoLabel(undefined, ACTOR_A, 'maria@example.com')).toBe('local');
  });
});

describe('redoable', () => {
  it('finds the most recent undo of the account\'s own that nothing later reversed', () => {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    const edited = setRackField(doc, rackId, 'row', 'Row A', { actor: ACTOR_A, now: NOW + 1 });
    const undone = undo(edited, edited.batches[1].id, { actor: ACTOR_A, now: NOW + 2 });
    const candidate = redoable(undone, ACTOR_A);
    expect(candidate?.id).toBe(undone.batches[2].id);
  });

  it('is undefined once the redo candidate has itself been redone', () => {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    const edited = setRackField(doc, rackId, 'row', 'Row A', { actor: ACTOR_A, now: NOW + 1 });
    const undone = undo(edited, edited.batches[1].id, { actor: ACTOR_A, now: NOW + 2 });
    const redone = redo(undone, undone.batches[2].id, { actor: ACTOR_A, now: NOW + 3 });
    expect(redoable(redone, ACTOR_A)).toBeUndefined();
  });

  it('never offers a plain (non-undo) batch, or another account\'s undo', () => {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    expect(redoable(doc, ACTOR_A)).toBeUndefined();
    const edited = setRackField(doc, rackId, 'row', 'Row A', { actor: ACTOR_A, now: NOW + 1 });
    const undone = undo(edited, edited.batches[1].id, { actor: ACTOR_A, now: NOW + 2 });
    expect(redoable(undone, ACTOR_B)).toBeUndefined();
  });
});

describe('trailRows', () => {
  it('lists batches newest first, an undo entry landing above the change it reverses', () => {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    const edited = setRackField(doc, rackId, 'row', 'Row A', { actor: ACTOR_A, now: NOW + 1 });
    const undone = undo(edited, edited.batches[1].id, { actor: ACTOR_A, now: NOW + 2 });

    const rows = trailRows(undone, ACTOR_A, 'me@example.com', new Set());
    expect(rows.map((r) => r.batchId)).toEqual([undone.batches[2].id, undone.batches[1].id, undone.batches[0].id]);
    expect(rows[0].what).toBe(`undo of ${undone.batches[1].label}`);
    expect(rows.every((r) => r.sealed === false)).toBe(true);
  });

  it('reads a batch as sealed only when its id is in the sealed set, and carries its comment', () => {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    const edited = setRackField(doc, rackId, 'row', 'Row A', { actor: ACTOR_A, now: NOW + 1 });
    const withComment: Document = {
      ...edited,
      batches: edited.batches.map((b, i) => (i === 1 ? { ...b, comment: 'moving the AP uplink' } : b)),
    };
    const sealed = new Set([withComment.batches[0].id]);
    const rows = trailRows(withComment, ACTOR_A, 'me@example.com', sealed);
    const sealedRow = rows.find((r) => r.batchId === withComment.batches[0].id)!;
    const pendingRow = rows.find((r) => r.batchId === withComment.batches[1].id)!;
    expect(sealedRow.sealed).toBe(true);
    expect(pendingRow.sealed).toBe(false);
    expect(pendingRow.why).toBe('moving the AP uplink');
  });
});
