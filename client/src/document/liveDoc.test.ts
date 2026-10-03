import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../api/catalogue';
import { applyChange, changeOf, type Change } from './change';
import { createRack, placeChassis, removeChassis } from './commands';
import { setChassisField, setDeviceField, setRackField } from './edit';
import {
  OVERWRITE_WINDOW_MS,
  applyReload,
  applyRefusal,
  applyRemote,
  droppedSentence,
  localEdit,
  openLive,
  overwriteLines,
  yoursLine,
  keepLabel,
  mergedSentence,
  mergedWith,
  panelLabel,
  elementName,
  PUT_BACK_LABEL,
  putMineBack,
  type Context,
  type LiveState,
} from './liveDoc';
import { edgesIn, emptyDocument, findNode, formatNodeId, type Document } from './model';
import { writePlain } from './plain';
import { newUlid } from './ulid';
import { redoSkipping, undoSkipping, UndoConflictError, undo } from './undo';

const T0 = 1_700_000_000_000;
const ME = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const THEM = '01BX5ZZKBKACTAV9WEVGEMMVRY';

const MODEL: CatalogueModel = {
  vendor: 'juniper',
  model: 'EX4300-48P',
  rackUnits: 1,
  reviewedBy: 'reviewer',
  source: { cite: 'cite', readOn: '2026-09-14' },
  psuSlots: [],
  faceplates: [{ face: 'front', portCount: 1, ports: [{ kind: 'RJ45', number: 0, uplink: false, row: 'single', column: 0, groupGapBefore: false }] }],
};

function bytes(d: Document): string {
  return Array.from(writePlain(d), (x) => x.toString(16).padStart(2, '0')).join('');
}

function world(): { base: Document; rackId: string; chassisId: string; deviceId: string } {
  const premisesId = formatNodeId('Premises', newUlid(T0));
  const empty: Document = { ...emptyDocument(), nodes: [{ id: premisesId, existence: newUlid(T0), fields: {} }] };
  const withRack = createRack(empty, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', actor: THEM, now: T0 + 1 });
  const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
  const placed = placeChassis(withRack, rackId, MODEL, 4, 'front', { actor: THEM, now: T0 + 2 });
  const chassisId = edgesIn(placed, rackId, 'MountedIn')[0].from;
  const deviceId = edgesIn(placed, chassisId, 'HasChassis')[0].from;
  return { base: placed, rackId, chassisId, deviceId };
}

const ctx = (now: number): Context => ({ me: ME, sittingStart: T0, now });

/** The server's next change, made by `THEM` from the server's current document. */
function theirs(server: Document, f: (d: Document) => Document): { change: Change; next: Document } {
  const next = f(server);
  return { change: changeOf(server, next), next };
}

describe('merge', () => {
  it('a remote change to another field merges with a pending one', () => {
    const { base, deviceId, rackId } = world();
    let s: LiveState = openLive(base, 10);
    s = localEdit(s, setDeviceField(s.visible, deviceId, 'hostname', 'mine', { actor: ME, now: T0 + 1000 })).state;
    expect(s.pending).toHaveLength(1);

    const remote = theirs(base, (d) => setRackField(d, rackId, 'row', 'Row A', { actor: THEM, now: T0 + 2000 }));
    const r = applyRemote(s, remote.change, 11, ctx(T0 + 3000));
    expect(r.echoed).toBe(false);
    expect(r.dropped).toEqual([]);
    expect(r.overwrites).toEqual([]);
    expect(r.state.version).toBe(11);
    expect(r.state.pending).toHaveLength(1);
    expect(findNode(r.state.visible, deviceId)!.fields['Device.hostname'].value).toBe('mine');
    expect(findNode(r.state.visible, rackId)!.fields['Rack.row'].value).toBe('Row A');
    expect(findNode(r.state.confirmed, deviceId)!.fields['Device.hostname']).toBeUndefined();
  });

  it('on the same field the later version wins: pending mine wins over their earlier arrival', () => {
    const { base, deviceId } = world();
    let s = openLive(base, 10);
    s = localEdit(s, setDeviceField(s.visible, deviceId, 'hostname', 'mine', { actor: ME, now: T0 + 1000 })).state;
    const remote = theirs(base, (d) => setDeviceField(d, deviceId, 'hostname', 'theirs', { actor: THEM, now: T0 + 2000 }));
    const r = applyRemote(s, remote.change, 11, ctx(T0 + 3000));
    expect(findNode(r.state.visible, deviceId)!.fields['Device.hostname'].value).toBe('mine');
    expect(findNode(r.state.confirmed, deviceId)!.fields['Device.hostname'].value).toBe('theirs');
    expect(r.overwrites).toEqual([]);

    // The server then takes mine at 12; every client ends on the same document.
    const mineChange = r.state.pending[0];
    const echoed = applyRemote(r.state, mineChange, 12, ctx(T0 + 4000));
    expect(echoed.echoed).toBe(true);
    expect(echoed.state.pending).toEqual([]);
    expect(bytes(echoed.state.visible)).toBe(bytes(echoed.state.confirmed));
    expect(findNode(echoed.state.confirmed, deviceId)!.fields['Device.hostname'].value).toBe('mine');
  });

  it('on the same field their later version wins, and the person is told', () => {
    const { base, deviceId } = world();
    // I wrote it and it is confirmed; then they write over it.
    const mine = setDeviceField(base, deviceId, 'hostname', 'mine', { actor: ME, now: T0 + 1000 });
    let s = openLive(base, 10);
    const edit = localEdit(s, mine);
    s = applyRemote(edit.state, edit.changes[0], 11, ctx(T0 + 1500)).state;
    expect(s.pending).toEqual([]);

    const remote = theirs(mine, (d) => setDeviceField(d, deviceId, 'hostname', 'theirs', { actor: THEM, now: T0 + 2000 }));
    const r = applyRemote(s, remote.change, 12, ctx(T0 + 3000));
    expect(findNode(r.state.visible, deviceId)!.fields['Device.hostname'].value).toBe('theirs');
    expect(r.overwrites).toHaveLength(1);
    const o = r.overwrites[0];
    expect(o).toMatchObject({
      element: deviceId,
      key: 'Device.hostname',
      by: THEM,
      mine: { presence: 'set', value: 'mine' },
      theirs: { presence: 'set', value: 'theirs' },
      on: 'theirs',
      putBack: false,
    });
    const nameOf = (a: string) => (a === THEM ? 'Bob' : 'Someone');
    expect(overwriteLines([o], nameOf)).toEqual(['Bob changed the name on theirs just after you']);
    expect(yoursLine(o, nameOf)).toBe("yours mine → Bob's theirs");
    expect(keepLabel([o], nameOf)).toBe("Keep Bob's");

    // Put mine back is an ordinary new change.
    const back = putMineBack(r.state.visible, o, { actor: ME, now: T0 + 4000 })!;
    const again = localEdit(r.state, back);
    expect(again.changes).toHaveLength(1);
    expect(findNode(again.state.visible, deviceId)!.fields['Device.hostname'].value).toBe('mine');
    expect(again.changes[0].batch.label).toBe(PUT_BACK_LABEL);
    const history = again.state.visible.history.find((h) => h.element === deviceId && h.field === 'Device.hostname')!;
    expect(history.entries.map((e) => e.value)).toEqual(['mine', 'theirs']);
  });
});

describe('the just-after-you window', () => {
  function setup(wroteAt: number, sitting = T0) {
    const { base, deviceId } = world();
    const mine = setDeviceField(base, deviceId, 'hostname', 'mine', { actor: ME, now: wroteAt });
    const edit = localEdit(openLive(base, 10), mine);
    const s = applyRemote(edit.state, edit.changes[0], 11, ctx(wroteAt)).state;
    const remote = theirs(mine, (d) => setDeviceField(d, deviceId, 'hostname', 'theirs', { actor: THEM, now: wroteAt + 5 }));
    return { s, remote, sitting };
  }

  it('shows inside ten minutes, not after', () => {
    const a = setup(T0 + 1000);
    expect(applyRemote(a.s, a.remote.change, 12, ctx(T0 + 1000 + OVERWRITE_WINDOW_MS)).overwrites).toHaveLength(1);
    const b = setup(T0 + 1000);
    expect(applyRemote(b.s, b.remote.change, 12, ctx(T0 + 1001 + OVERWRITE_WINDOW_MS)).overwrites).toHaveLength(0);
  });

  it('shows only for what was set in this sitting', () => {
    const a = setup(T0 + 1000);
    const later = { ...ctx(T0 + 2000), sittingStart: T0 + 1500 };
    expect(applyRemote(a.s, a.remote.change, 12, later).overwrites).toHaveLength(0);
  });

  it('is silent when the field was not mine', () => {
    const { base, deviceId } = world();
    const s = openLive(base, 10);
    const remote = theirs(base, (d) => setDeviceField(d, deviceId, 'hostname', 'theirs', { actor: THEM, now: T0 + 2000 }));
    expect(applyRemote(s, remote.change, 11, ctx(T0 + 3000)).overwrites).toEqual([]);
  });
});

describe('pending changes', () => {
  it('drops a pending change that no longer applies and says so in one sentence', () => {
    const { base, deviceId, chassisId } = world();
    let s = openLive(base, 10);
    s = localEdit(s, setDeviceField(s.visible, deviceId, 'hostname', 'mine', { actor: ME, now: T0 + 1000 })).state;
    const remote = theirs(base, (d) => removeChassis(d, chassisId, { actor: THEM, now: T0 + 2000 }));
    // The device is removed with the chassis; my field change on it still applies (tombstones keep the element).
    const kept = applyRemote(s, remote.change, 11, ctx(T0 + 3000));
    expect(kept.dropped).toEqual([]);

    // A change naming an element the remote document never had cannot apply.
    const ghost = formatNodeId('Device', newUlid(T0 + 9));
    const orphan: Change = {
      batch: { id: newUlid(T0 + 9), label: 'set Device.hostname', ops: [{ type: 'set_field', element: ghost, key: 'Device.hostname', presence: 'absent', prov: kept.state.pending[0].provenance[0].id }] },
      provenance: [],
      values: [],
    };
    const withOrphan: LiveState = { ...kept.state, pending: [...kept.state.pending, orphan] };
    const r = applyRemote(withOrphan, changeOf(remote.next, setChassisField(remote.next, chassisId, 'serial', 'S1', { actor: THEM, now: T0 + 4000 })), 12, ctx(T0 + 5000));
    expect(r.dropped.map((c) => c.batch.id)).toEqual([orphan.batch.id]);
    expect(r.state.pending).toHaveLength(1);
    expect(droppedSentence(r.dropped)).toBe('Your change "set Device.hostname" no longer fit what others did, so it was left out.');
    expect(droppedSentence([])).toBe('');
  });

  it('recognises its own change coming back by batch id', () => {
    const { base, deviceId } = world();
    const edit = localEdit(openLive(base, 10), setDeviceField(base, deviceId, 'hostname', 'mine', { actor: ME, now: T0 + 1000 }));
    const visibleBefore = edit.state.visible;
    const r = applyRemote(edit.state, edit.changes[0], 11, ctx(T0 + 2000));
    expect(r.echoed).toBe(true);
    expect(r.state.pending).toEqual([]);
    expect(r.state.visible).toBe(visibleBefore);
    expect(r.state.version).toBe(11);
    expect(r.overwrites).toEqual([]);
  });

  it('ignores a repeat and reports a gap', () => {
    const { base, deviceId } = world();
    const s = openLive(base, 10);
    const remote = theirs(base, (d) => setDeviceField(d, deviceId, 'hostname', 'theirs', { actor: THEM, now: T0 + 2000 }));
    expect(applyRemote(s, remote.change, 10, ctx(T0)).state).toBe(s);
    expect(applyRemote(s, remote.change, 12, ctx(T0)).gap).toBe(true);
  });

  it('a refusal drops that change and rebuilds what is shown', () => {
    const { base, deviceId, rackId } = world();
    let s = openLive(base, 10);
    s = localEdit(s, setDeviceField(s.visible, deviceId, 'hostname', 'one', { actor: ME, now: T0 + 1000 })).state;
    s = localEdit(s, setRackField(s.visible, rackId, 'row', 'Row Z', { actor: ME, now: T0 + 1100 })).state;
    const r = applyRefusal(s, s.pending[0].batch.id);
    expect(r.dropped).toHaveLength(1);
    expect(r.state.pending).toHaveLength(1);
    expect(findNode(r.state.visible, deviceId)!.fields['Device.hostname']).toBeUndefined();
    expect(findNode(r.state.visible, rackId)!.fields['Rack.row'].value).toBe('Row Z');
    expect(applyRefusal(r.state, 'nothing').dropped).toEqual([]);
  });

  it('on reload, reopens the design and replays what is pending on top', () => {
    const { base, deviceId, rackId } = world();
    let s = openLive(base, 10);
    s = localEdit(s, setDeviceField(s.visible, deviceId, 'hostname', 'mine', { actor: ME, now: T0 + 1000 })).state;
    const whole = setRackField(base, rackId, 'row', 'Whole save', { actor: THEM, now: T0 + 2000 });
    const r = applyReload(s, whole, 15);
    expect(r.dropped).toEqual([]);
    expect(r.state.version).toBe(15);
    expect(findNode(r.state.visible, deviceId)!.fields['Device.hostname'].value).toBe('mine');
    expect(findNode(r.state.visible, rackId)!.fields['Rack.row'].value).toBe('Whole save');
    expect(r.state.confirmed).toBe(whole);

    // A pending change the new document cannot take is dropped.
    const without = { ...whole, nodes: whole.nodes.filter((n) => n.id !== deviceId) };
    expect(applyReload(s, without, 16).dropped).toHaveLength(1);
  });
});

describe('local edits', () => {
  it('builds one change per appended batch and keeps the visible document', () => {
    const { base, deviceId, chassisId } = world();
    const s = openLive(base, 10);
    const next = setChassisField(setDeviceField(base, deviceId, 'hostname', 'a', { actor: ME, now: T0 + 1000 }), chassisId, 'serial', 'S', { actor: ME, now: T0 + 1001 });
    const r = localEdit(s, next);
    expect(r.changes).toHaveLength(2);
    expect(r.state.visible).toBe(next);
    let d = base;
    for (const c of r.changes) d = applyChange(d, c);
    expect(bytes(d)).toBe(bytes(next));
  });

  it('applies an edit made against an older document to what is shown now', () => {
    const { base, deviceId, rackId } = world();
    let s = openLive(base, 10);
    const stale = setDeviceField(base, deviceId, 'hostname', 'mine', { actor: ME, now: T0 + 1000 });
    const remote = theirs(base, (d) => setRackField(d, rackId, 'row', 'Row A', { actor: THEM, now: T0 + 900 }));
    s = applyRemote(s, remote.change, 11, ctx(T0 + 950)).state;
    const r = localEdit(s, stale);
    expect(r.changes).toHaveLength(1);
    expect(findNode(r.state.visible, rackId)!.fields['Rack.row'].value).toBe('Row A');
    expect(findNode(r.state.visible, deviceId)!.fields['Device.hostname'].value).toBe('mine');
  });

  it('a comment attached afterwards rides on the pending change', () => {
    const { base, deviceId } = world();
    const edit = localEdit(openLive(base, 10), setDeviceField(base, deviceId, 'hostname', 'a', { actor: ME, now: T0 + 1000 }));
    const last = edit.state.visible.batches[edit.state.visible.batches.length - 1];
    const commented = { ...edit.state.visible, batches: edit.state.visible.batches.map((b) => (b.id === last.id ? { ...b, comment: 'why' } : b)) };
    const r = localEdit(edit.state, commented);
    expect(r.changes).toEqual([]);
    expect(r.state.pending[0].batch.comment).toBe('why');
    expect(r.state.visible.batches[r.state.visible.batches.length - 1].comment).toBe('why');
  });
});

describe('undo leaves what others changed', () => {
  it('skips a field someone else wrote since, undoes the rest, and names what was left', () => {
    const { base, deviceId, chassisId } = world();
    // One batch of mine setting two fields is not a command here; two batches instead.
    const a = setDeviceField(base, deviceId, 'hostname', 'mine', { actor: ME, now: T0 + 1000 });
    const target = a.batches[a.batches.length - 1];
    const b = setDeviceField(a, deviceId, 'hostname', 'theirs', { actor: THEM, now: T0 + 2000 });

    // Plain undo refuses; the live one skips the field and does nothing at all here.
    expect(() => undo(b, target.id, { actor: ME, now: T0 + 3000 })).toThrow(UndoConflictError);
    const r = undoSkipping(b, target.id, { actor: ME, now: T0 + 3000 });
    expect(r.skipped).toEqual([{ element: deviceId, key: 'Device.hostname' }]);
    expect(r.doc).toBe(b);

    // A batch with two parts: only the part another person touched is left.
    const two = setChassisField(a, chassisId, 'serial', 'S1', { actor: ME, now: T0 + 1500 });
    const merged: Document = {
      ...two,
      batches: [
        ...two.batches.slice(0, -2),
        { ...two.batches[two.batches.length - 2], ops: [...two.batches[two.batches.length - 2].ops, ...two.batches[two.batches.length - 1].ops] },
      ],
    };
    const mergedId = merged.batches[merged.batches.length - 1].id;
    const theirsLater = setDeviceField(merged, deviceId, 'hostname', 'theirs', { actor: THEM, now: T0 + 2000 });
    const u = undoSkipping(theirsLater, mergedId, { actor: ME, now: T0 + 3000 });
    expect(u.skipped).toEqual([{ element: deviceId, key: 'Device.hostname' }]);
    expect(findNode(u.doc, chassisId)!.fields['Chassis.serial']).toBeUndefined();
    expect(findNode(u.doc, deviceId)!.fields['Device.hostname'].value).toBe('theirs');
    expect(u.doc.batches[u.doc.batches.length - 1].reverses).toBe(mergedId);

    // Redo the same way.
    const redone = redoSkipping(u.doc, u.doc.batches[u.doc.batches.length - 1].id, { actor: ME, now: T0 + 4000 });
    expect(redone.skipped).toEqual([]);
  });

  it('a field nobody else wrote is undone as before', () => {
    const { base, deviceId } = world();
    const a = setDeviceField(base, deviceId, 'hostname', 'mine', { actor: ME, now: T0 + 1000 });
    const r = undoSkipping(a, a.batches[a.batches.length - 1].id, { actor: ME, now: T0 + 2000 });
    expect(r.skipped).toEqual([]);
    expect(findNode(r.doc, deviceId)!.fields['Device.hostname']).toBeUndefined();
  });
});

describe('the words of a notice', () => {
  const name = (a: string) => ({ [THEM]: 'Bob', [ME]: 'Ann' })[a] ?? 'Someone';
  const o = (key: string, by: string, on: string, extra: Partial<import('./liveDoc').Overwrite> = {}): import('./liveDoc').Overwrite => ({
    element: 'e',
    key,
    by,
    mine: { presence: 'set', value: 'SN-ANN-1' },
    theirs: { presence: 'set', value: 'SN-BOB-2' },
    on,
    putBack: false,
    at: 1,
    ...extra,
  });

  it('names the person, the field by its panel label and the device, once for several fields', () => {
    expect(overwriteLines([o('Chassis.serial', THEM, 'core-sw-01')], name)).toEqual(['Bob changed the serial on core-sw-01 just after you']);
    expect(overwriteLines([o('Chassis.serial', THEM, 'core-sw-01'), o('Device.management_address', THEM, 'core-sw-01')], name)).toEqual([
      'Bob changed the serial and the mgmt address on core-sw-01 just after you',
    ]);
    expect(overwriteLines([o('Chassis.serial', THEM, 'a'), o('Rack.row', 'x', 'b')], name)).toHaveLength(2);
  });

  it('says a put-back as a put-back, without guessing a pronoun', () => {
    expect(overwriteLines([o('Chassis.serial', ME, 'core-sw-01', { putBack: true })], name)).toEqual(['Ann put back the serial on core-sw-01']);
  });

  it('shows yours and theirs on one mono line, and an empty field as a dash', () => {
    expect(yoursLine(o('Chassis.serial', THEM, 'x'), name)).toBe("yours SN-ANN-1 → Bob's SN-BOB-2");
    expect(yoursLine(o('Chassis.serial', THEM, 'x', { theirs: { presence: 'unknown' } }), name)).toBe("yours SN-ANN-1 → Bob's –");
  });

  it('keeps one person’s name on the button and falls back to "theirs" for several', () => {
    expect(keepLabel([o('Chassis.serial', THEM, 'x')], name)).toBe("Keep Bob's");
    expect(keepLabel([o('Chassis.serial', THEM, 'x'), o('Rack.row', 'y', 'x')], name)).toBe('Keep theirs');
  });

  it('says a merge once, with the field the person changed', () => {
    expect(mergedSentence(['Device.role'], 'Bob')).toBe("Your role change merged with Bob's. Both are in history.");
    expect(mergedSentence(['Chassis.serial', 'Device.role'], 'Bob')).toBe("Your serial and role changes merged with Bob's. Both are in history.");
  });

  it('labels fields as the panel does and names an element by its device', () => {
    expect(panelLabel('Chassis.serial')).toBe('serial');
    expect(panelLabel('Device.management_address')).toBe('mgmt address');
    expect(panelLabel('Foo.some_thing')).toBe('some thing');
    const { base, deviceId, chassisId } = world();
    const named = setDeviceField(base, deviceId, 'hostname', 'core-sw-01', { actor: ME, now: T0 + 5 });
    expect(elementName(named, chassisId)).toBe('core-sw-01');
    expect(elementName(named, deviceId)).toBe('core-sw-01');
    expect(elementName(base, chassisId)).toBe('an unnamed device');
  });
});

describe('a merge on the same thing', () => {
  it('is found when another person changes a different field of the element this person changed', () => {
    const { base, rackId } = world();
    const mine = setRackField(base, rackId, 'row', 'Row A', { actor: ME, now: T0 + 1000 });
    const edit = localEdit(openLive(base, 10), mine);
    const s = applyRemote(edit.state, edit.changes[0], 11, ctx(T0 + 1500)).state;
    const remote = theirs(mine, (d) => setRackField(d, rackId, 'bay', 2, { actor: THEM, now: T0 + 2000 }));
    const r = applyRemote(s, remote.change, 12, ctx(T0 + 3000));
    expect(r.overwrites).toEqual([]);
    expect(r.merged).toEqual({ by: THEM, keys: ['Rack.row'] });
    // Out of the window, or not this sitting, there is nothing to say.
    expect(mergedWith(s.visible, remote.change, ctx(T0 + 1000 + OVERWRITE_WINDOW_MS + 1))).toBeNull();
    expect(mergedWith(s.visible, remote.change, { ...ctx(T0 + 3000), sittingStart: T0 + 2500 })).toBeNull();
  });

  it('is not a merge when it is the same field', () => {
    const { base, rackId } = world();
    const mine = setRackField(base, rackId, 'row', 'Row A', { actor: ME, now: T0 + 1000 });
    const edit = localEdit(openLive(base, 10), mine);
    const s = applyRemote(edit.state, edit.changes[0], 11, ctx(T0 + 1500)).state;
    const remote = theirs(mine, (d) => setRackField(d, rackId, 'row', 'Row B', { actor: THEM, now: T0 + 2000 }));
    const r = applyRemote(s, remote.change, 12, ctx(T0 + 3000));
    expect(r.merged).toBeNull();
    expect(r.overwrites).toHaveLength(1);
  });
});
