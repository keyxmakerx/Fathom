import { describe, expect, it } from 'vitest';

import { createRack } from '../../document/commands';
import { setRackField } from '../../document/edit';
import { LOCAL_ACTOR, emptyDocument, formatNodeId, type Document } from '../../document/model';
import { newUlid } from '../../document/ulid';
import { redo, undo } from '../../document/undo';
import { recordLines, recordWhen, redoable, trailRows, utcOffset, whoLabel, type TrailRow } from './trail';

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

/** Histories' word for a person, as `whoNamer` gives it once a design has heard Bob's name. */
const nameOf = (account: string) => (account === ACTOR_A ? 'you' : account === ACTOR_B ? 'Bob Roe' : 'a colleague');

describe('whoLabel', () => {
  it('says what every other history says for a person', () => {
    expect(whoLabel(ACTOR_A, nameOf)).toBe('you');
    expect(whoLabel(ACTOR_B, nameOf)).toBe('Bob Roe');
    expect(whoLabel('01ARZ3NDEKTSV4RRFFQ69G5FCV', nameOf)).toBe('a colleague');
  });

  it('reads a LOCAL-stamped or mixed batch as local, without asking for a name', () => {
    const never = () => {
      throw new Error('asked for a name');
    };
    expect(whoLabel(LOCAL_ACTOR, never)).toBe('local');
    expect(whoLabel(undefined, never)).toBe('local');
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

  it('takes the later of two undos first, which brings back the older change', () => {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    const one = setRackField(doc, rackId, 'row', 'Row A', { actor: ACTOR_A, now: NOW + 1 });
    const two = setRackField(one, rackId, 'bay', 2, { actor: ACTOR_A, now: NOW + 2 });
    const undoneTwo = undo(two, two.batches[2].id, { actor: ACTOR_A, now: NOW + 3 });
    const undoneOne = undo(undoneTwo, two.batches[1].id, { actor: ACTOR_A, now: NOW + 4 });
    expect(redoable(undoneOne, ACTOR_A)?.label).toBe('undo of set Rack.row');
    const redone = redo(undoneOne, redoable(undoneOne, ACTOR_A)!.id, { actor: ACTOR_A, now: NOW + 5 });
    expect(redoable(redone, ACTOR_A)?.label).toBe('undo of set Rack.bay');
  });

  it('offers nothing once a change has been made since the undo', () => {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    const edited = setRackField(doc, rackId, 'row', 'Row A', { actor: ACTOR_A, now: NOW + 1 });
    const undone = undo(edited, edited.batches[1].id, { actor: ACTOR_A, now: NOW + 2 });
    const since = setRackField(undone, rackId, 'bay', 2, { actor: ACTOR_A, now: NOW + 3 });
    expect(redoable(since, ACTOR_A)).toBeUndefined();
    // A colleague's change is not one of this account's steps, and puts nothing away.
    const theirs = setRackField(undone, rackId, 'bay', 2, { actor: ACTOR_B, now: NOW + 3 });
    expect(redoable(theirs, ACTOR_A)?.id).toBe(undone.batches[2].id);
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

    const rows = trailRows(undone, nameOf, new Set());
    expect(rows.map((r) => r.batchId)).toEqual([undone.batches[2].id, undone.batches[1].id, undone.batches[0].id]);
    expect(rows[0].label).toBe(`undo of ${undone.batches[1].label}`);
    expect(rows.every((r) => r.sealed === false)).toBe(true);
  });

  it('says what changed in words and to what, and keeps the label as recorded beside them', () => {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    const edited = setRackField(doc, rackId, 'row', 'Row A', { actor: ACTOR_A, now: NOW + 1 });
    const undone = undo(edited, edited.batches[1].id, { actor: ACTOR_A, now: NOW + 2 });
    const redone = redo(undone, undone.batches[2].id, { actor: ACTOR_A, now: NOW + 3 });

    const rows = trailRows(redone, nameOf, new Set());
    expect(rows.map((r) => r.what)).toEqual(['Redone: rack moved to another row', 'Undone: rack moved to another row', 'Rack moved to another row', 'Rack added']);
    expect(rows.map((r) => r.on)).toEqual(['R1', 'R1', 'R1', 'R1']);
    expect(rows.map((r) => r.label)).toEqual(['redo of undo of set Rack.row', 'undo of set Rack.row', 'set Rack.row', 'create rack']);
  });

  it('names who made each change and never shows a piece of an account id, which the row keeps whole', () => {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    const theirs = setRackField(doc, rackId, 'row', 'Row A', { actor: ACTOR_B, now: NOW + 1 });
    const unheard = setRackField(theirs, rackId, 'bay', 2, { actor: '01ARZ3NDEKTSV4RRFFQ69G5FCV', now: NOW + 2 });

    const rows = trailRows(unheard, nameOf, new Set());
    expect(rows.map((r) => r.who)).toEqual(['a colleague', 'Bob Roe', 'you']);
    expect(rows.map((r) => r.account)).toEqual(['01ARZ3NDEKTSV4RRFFQ69G5FCV', ACTOR_B, ACTOR_A]);
    for (const r of rows) expect(r.who).not.toMatch(/01ARZ3ND/);
  });

  it('gives a change that is nobody\'s no account', () => {
    const { doc } = docWithRack(LOCAL_ACTOR, NOW);
    const rows = trailRows(doc, nameOf, new Set());
    expect(rows[0].who).toBe('local');
    expect(rows[0].account).toBeNull();
  });

  it('reads a batch as sealed only when its id is in the sealed set, and carries its comment', () => {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    const edited = setRackField(doc, rackId, 'row', 'Row A', { actor: ACTOR_A, now: NOW + 1 });
    const withComment: Document = {
      ...edited,
      batches: edited.batches.map((b, i) => (i === 1 ? { ...b, comment: 'moving the AP uplink' } : b)),
    };
    const sealed = new Set([withComment.batches[0].id]);
    const rows = trailRows(withComment, nameOf, sealed);
    const sealedRow = rows.find((r) => r.batchId === withComment.batches[0].id)!;
    const pendingRow = rows.find((r) => r.batchId === withComment.batches[1].id)!;
    expect(sealedRow.sealed).toBe(true);
    expect(pendingRow.sealed).toBe(false);
    expect(pendingRow.why).toBe('moving the AP uplink');
  });
});

describe('the record behind a row', () => {
  const ACTOR_C = '01ARZ3NDEKTSV4RRFFQ69G5FCV';
  // Built from the clock's own parts, so it reads the same wherever the test runs.
  const AT = new Date(2026, 10, 20, 21, 4, 7).getTime();
  const HERE = utcOffset(-new Date(AT).getTimezoneOffset());
  const row = (over: Partial<TrailRow>): TrailRow => ({ batchId: 'b', whenMs: AT, who: 'you', account: ACTOR_A, what: 'Rack moved to another row', on: 'R1', label: 'set Rack.row', why: null, sealed: true, ...over });
  const me = { accountId: ACTOR_A, address: 'ana@example.net' };
  const valueOf = (lines: ReturnType<typeof recordLines>, label: string) => lines.find((l) => l.label === label)?.value;

  it('says how far a clock is from UTC the way a log does', () => {
    expect(utcOffset(-360)).toBe('UTC-06:00');
    expect(utcOffset(330)).toBe('UTC+05:30');
    expect(utcOffset(-210)).toBe('UTC-03:30');
    expect(utcOffset(765)).toBe('UTC+12:45');
    expect(utcOffset(0)).toBe('UTC');
  });

  it('gives the whole moment: the day, the year and the second, and how far the clock is from UTC', () => {
    expect(recordWhen(AT)).toBe(`20 Nov 2026 21:04:07 (${HERE})`);
    expect(recordWhen(new Date(2027, 0, 3, 0, 0, 0).getTime())).toMatch(/^3 Jan 2027 00:00:00 \(UTC/);
  });

  it('gives no moment for a batch whose id carries none', () => {
    expect(recordWhen(0)).toBeNull();
    expect(recordWhen(Number.NaN)).toBeNull();
    expect(recordLines(row({ whenMs: 0 }), me).map((l) => l.label)).toEqual(['Account', 'Account id', 'Recorded as']);
  });

  it('lists the moment, the account and the label as recorded, in that order', () => {
    const lines = recordLines(row({}), me);
    expect(lines.map((l) => l.label)).toEqual(['When', 'Account', 'Account id', 'Recorded as']);
    expect(valueOf(lines, 'When')).toBe(`20 Nov 2026 21:04:07 (${HERE})`);
    expect(valueOf(lines, 'Recorded as')).toBe('set Rack.row');
  });

  it('shows the reader their own address above their account id', () => {
    const mine = recordLines(row({}), me);
    expect(valueOf(mine, 'Account')).toBe('ana@example.net');
    expect(valueOf(mine, 'Account id')).toBe(ACTOR_A);
    // Signed in, but the address is not known yet: the row already says "you", so the id alone.
    const early = recordLines(row({}), { accountId: ACTOR_A, address: null });
    expect(early.map((l) => l.label)).toEqual(['When', 'Account id', 'Recorded as']);
    expect(valueOf(early, 'Account id')).toBe(ACTOR_A);
  });

  it('gives a colleague this design has heard their whole name, and one it has not only the id', () => {
    const heard = recordLines(row({ who: 'Bartholomew Roe-Castellanos', account: ACTOR_B }), me);
    expect(valueOf(heard, 'Account')).toBe('Bartholomew Roe-Castellanos');
    expect(valueOf(heard, 'Account id')).toBe(ACTOR_B);
    const unheard = recordLines(row({ who: 'a colleague', account: ACTOR_C }), me);
    expect(unheard.map((l) => l.label)).toEqual(['When', 'Account id', 'Recorded as']);
    expect(valueOf(unheard, 'Account id')).toBe(ACTOR_C);
  });

  it('never shows the reader\'s address on a row that is not theirs', () => {
    for (const other of [row({ who: 'Bob Roe', account: ACTOR_B }), row({ who: 'a colleague', account: ACTOR_C }), row({ who: 'local', account: null })]) {
      for (const line of recordLines(other, me)) expect(line.value).not.toContain('ana@example.net');
    }
  });

  it('says so where a change belongs to no one account, and makes up no id for it', () => {
    for (const reader of [me, { accountId: null, address: null }]) {
      const lines = recordLines(row({ who: 'local', account: null }), reader);
      expect(lines.map((l) => l.label)).toEqual(['When', 'Account', 'Recorded as']);
      expect(valueOf(lines, 'Account')).toBe('No single account is recorded for this change');
    }
  });

  it('reads a real trail: an undo keeps its label as it was written', () => {
    const { doc, rackId } = docWithRack(ACTOR_A, AT);
    const edited = setRackField(doc, rackId, 'row', 'Row A', { actor: ACTOR_B, now: AT + 1000 });
    const undone = undo(edited, edited.batches[1].id, { actor: ACTOR_B, now: AT + 2000 });
    const [top, , first] = trailRows(undone, nameOf, new Set());
    expect(recordLines(top, me)).toEqual([
      { label: 'When', value: `20 Nov 2026 21:04:09 (${HERE})` },
      { label: 'Account', value: 'Bob Roe' },
      { label: 'Account id', value: ACTOR_B },
      { label: 'Recorded as', value: 'undo of set Rack.row' },
    ]);
    expect(recordLines(first, me).slice(1, 3)).toEqual([
      { label: 'Account', value: 'ana@example.net' },
      { label: 'Account id', value: ACTOR_A },
    ]);
  });
});
