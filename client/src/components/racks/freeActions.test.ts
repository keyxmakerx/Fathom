import { describe, expect, it } from 'vitest';

import { emptyDocument } from '../../document/model';
import { viewOf } from '../../document/view';
import { createFreeBox } from '../../document/freeform';
import { addSketchPortRange } from '../../document/commands';
import { setChassisField } from '../../document/edit';
import { addNote } from '../../document/notes';
import { addFreeBoxDoc, duplicateFreeDoc } from './freeActions';

const empty = () => emptyDocument();

describe('free actions', () => {
  it('adds a named switch with its ports, joined to another box, in one undo step', () => {
    const a = addFreeBoxDoc(empty(), 'router', 40, 40, undefined);
    const before = a.doc.batches.length;
    const b = addFreeBoxDoc(a.doc, 'switch', 200, 40, a.chassisId);
    expect(b.doc.batches.length).toBe(before + 1);
    const v = viewOf(b.doc, []);
    expect(v.free.map((f) => f.hostname).sort()).toEqual(['router-1', 'switch-1']);
    expect(v.free.find((f) => f.role === 'switch')?.portCount).toBeGreaterThan(0);
    expect(v.lines).toHaveLength(1);
  });

  it('duplicates boxes with the line between them, offset and renamed', () => {
    const a = addFreeBoxDoc(empty(), 'router', 40, 40, undefined);
    const b = addFreeBoxDoc(a.doc, 'switch', 200, 40, a.chassisId);
    const view = viewOf(b.doc, []);
    const copy = duplicateFreeDoc(b.doc, view, [a.chassisId, b.chassisId], 24, 24);
    expect(copy.ids).toHaveLength(2);
    expect(copy.doc.batches.length).toBe(b.doc.batches.length + 1);
    const v = viewOf(copy.doc, []);
    expect(v.free).toHaveLength(4);
    expect(v.lines).toHaveLength(2);
    expect(v.free.find((f) => f.hostname === 'router-2')).toMatchObject({ x: 64, y: 64 });
  });

  it('copies the ports and the role of a hand-made box, named the next in sequence, one undo step', () => {
    const made = createFreeBox(empty(), { x: 40, y: 40, hostname: 'sw-02', role: 'switch' });
    const withPorts = addSketchPortRange(made.doc, made.chassisId, { labelPrefix: 'eth', first: 0, last: 3, connector: 'rj45', service: 'ethernet', face: 'front' });
    const before = withPorts.batches.length;
    const copy = duplicateFreeDoc(withPorts, viewOf(withPorts, []), [made.chassisId], 24, 24);
    expect(copy.doc.batches.length).toBe(before + 1);
    const v = viewOf(copy.doc, []);
    const dup = v.free.find((f) => f.id === copy.ids[0])!;
    expect(dup).toMatchObject({ hostname: 'sw-03', role: 'switch', portCount: 4, x: 64, y: 64 });
  });

  it('never copies the serial or a note', () => {
    const made = createFreeBox(empty(), { x: 0, y: 0, hostname: 'sw-02', role: 'switch' });
    const withSerial = setChassisField(made.doc, made.chassisId, 'serial', 'SN-1');
    const withNote = addNote(withSerial, made.deviceId, { text: 'secret place', how: 'typed' });
    const copy = duplicateFreeDoc(withNote, viewOf(withNote, []), [made.chassisId], 24, 24);
    const node = copy.doc.nodes.find((n) => n.id === copy.ids[0])!;
    expect(node.fields['Chassis.serial']).toBeUndefined();
    expect(JSON.stringify(copy.doc.nodes.filter((n) => !withNote.nodes.some((o) => o.id === n.id)))).not.toContain('secret place');
  });

  it('keeps counting past names that are taken', () => {
    const made = createFreeBox(empty(), { x: 0, y: 0, hostname: 'sw-02', role: 'switch' });
    const view = viewOf(made.doc, []);
    const first = duplicateFreeDoc(made.doc, view, [made.chassisId], 24, 24);
    const second = duplicateFreeDoc(first.doc, viewOf(first.doc, []), [made.chassisId], 48, 48);
    expect(viewOf(second.doc, []).free.map((f) => f.hostname).sort()).toEqual(['sw-02', 'sw-03', 'sw-04']);
  });
});
