import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../api/catalogue';
import { applyChange, ChangeError, changeOf, changesOf, readChange, writeChange, type Change } from './change';
import { connectPorts, disconnect, setCableField } from './cables';
import {
  addSketchPort,
  addSketchPortRange,
  createBoard,
  createRack,
  createShelf,
  createSketchDevice,
  createSurface,
  duplicateDevice,
  moveChassis,
  movePlacement,
  placeChassis,
  placeOnShelf,
  removeChassis,
  removeSketchPort,
  resizeShelf,
} from './commands';
import { setChassisField, setDeviceField, setPassiveNodeField, setRackField, setRackHeight } from './edit';
import { createFreeBox, createLabel, createLine, moveFree, removeFree, setLabel, setLineLabel } from './freeform';
import { edgesIn, edgesOut, emptyDocument, findNode, formatNodeId, parseNodeId, type Document } from './model';
import { addNote, removeNote } from './notes';
import { writePlain } from './plain';
import { fitSupply, removeSupply, setSupplyField } from './supplies';
import { tagObject, untagObject, renameTag } from './tags';
import { newUlid } from './ulid';
import { redo, undo } from './undo';
import { addVlan } from './networks';

const NOW = 1_700_000_000_000;
const ME = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER = '01BX5ZZKBKACTAV9WEVGEMMVRY';

const MODEL: CatalogueModel = {
  vendor: 'juniper',
  model: 'EX4300-48P',
  rackUnits: 1,
  reviewedBy: 'reviewer',
  source: { cite: 'cite', readOn: '2026-09-14' },
  psuSlots: [
    { name: 'PSU0', hotSwap: true, face: 'rear', position: { row: 'single', column: 0 } },
    { name: 'PSU1', hotSwap: true, face: 'rear', position: { row: 'single', column: 1 } },
  ],
  faceplates: [
    {
      face: 'front',
      portCount: 2,
      ports: [
        { kind: 'RJ45', number: 0, uplink: false, row: 'top', column: 0, groupGapBefore: false },
        { kind: 'RJ45', number: 1, uplink: false, row: 'bottom', column: 0, groupGapBefore: false },
      ],
    },
  ],
};

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Applies every change `before -> after` through the wire format and checks the result is `after`. */
function check(before: Document, after: Document): void {
  let d = before;
  for (const change of changesOf(before, after)) {
    // The server takes exactly the provenance a change's ops name, and fills `supersedes` itself.
    const named = new Set(change.batch.ops.flatMap((op) => ('prov' in op ? [op.prov] : [])));
    expect(change.provenance.map((p) => p.id).sort()).toEqual([...named].sort());
    expect(change.provenance.every((p) => p.supersedes === undefined)).toBe(true);
    const bytes = writeChange(change);
    const back = readChange(bytes);
    expect(hex(writeChange(back))).toBe(hex(bytes));
    d = applyChange(d, back);
  }
  expect(d).toEqual(after);
  expect(hex(writePlain(d))).toBe(hex(writePlain(after)));
}

function freshNodes(before: Document, after: Document, kind: string): string[] {
  const known = new Set(before.nodes.map((n) => n.id));
  return after.nodes.filter((n) => !known.has(n.id) && parseNodeId(n.id).kind === kind).map((n) => n.id);
}

describe('applyChange(before, changeOf(before, after)) reproduces after', () => {
  it('holds for a long run of commands, undo and redo included', () => {
    const premisesId = formatNodeId('Premises', newUlid(NOW));
    let doc: Document = {
      ...emptyDocument(),
      nodes: [{ id: premisesId, existence: newUlid(NOW), fields: { 'Premises.label': { presence: 'set', prov: newUlid(NOW), value: 'HQ' } } }],
    };
    let t = NOW;
    const o = (actor = ME) => ({ actor, now: (t += 1000) });
    const step = (f: (d: Document) => Document): Document => {
      const next = f(doc);
      if (next === doc) return doc;
      check(doc, next);
      doc = next;
      return doc;
    };

    step((d) => createRack(d, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', ...o() }));
    const rackId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Rack')!.id;
    step((d) => setRackField(d, rackId, 'row', 'Row A', o()));
    step((d) => setRackField(d, rackId, 'row', 'Row B', o()));
    step((d) => setRackField(d, rackId, 'bay', 3, o()));
    step((d) => setRackField(d, rackId, 'bay', null, o()));
    step((d) => setRackHeight(d, rackId, 24, o()));

    step((d) => placeChassis(d, rackId, MODEL, 5, 'front', o()));
    const chassisId = edgesIn(doc, rackId, 'MountedIn')[0].from;
    const deviceId = edgesIn(doc, chassisId, 'HasChassis')[0].from;
    step((d) => setDeviceField(d, deviceId, 'hostname', 'sw-1', o()));
    step((d) => setDeviceField(d, deviceId, 'hostname', 'sw-2', o()));
    step((d) => setDeviceField(d, deviceId, 'role', 'switch', o()));
    step((d) => setDeviceField(d, deviceId, 'role', null, o()));
    step((d) => setChassisField(d, chassisId, 'serial', 'SN1', o()));
    step((d) => moveChassis(d, chassisId, rackId, 9, 'rear', o()));

    step((d) => placeChassis(d, rackId, MODEL, 20, 'front', o()));
    const chassis2 = edgesIn(doc, rackId, 'MountedIn').find((e) => e.from !== chassisId)!.from;
    const ports = (c: string) => edgesOut(doc, c, 'HasPort').map((e) => e.to);
    step((d) => connectPorts(d, ports(chassisId)[0], ports(chassis2)[0], { sheath: 'blue' }, o()));
    const cableId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Cable')!.id;
    step((d) => setCableField(d, cableId, 'length_m', 3, o()));
    step((d) => setCableField(d, cableId, 'length_m', 4, o()));
    step((d) => disconnect(d, cableId, o()));

    const supplyId = edgesOut(doc, chassisId, 'FittedIn').find((e) => e.to && findNode(doc, e.to)?.fields['PowerSupply.slot']?.value === 'PSU0')!.to;
    step((d) => setSupplyField(d, supplyId, 'serial', 'PS1', o()));
    step((d) => setSupplyField(d, supplyId, 'serial', null, o()));
    step((d) => removeSupply(d, supplyId, o()));
    step((d) => fitSupply(d, chassisId, 'PSU0', {}, o()));

    step((d) => addNote(d, deviceId, { text: 'hello', how: 'typed', ...o() }));
    const noteId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Note')!.id;
    step((d) => removeNote(d, noteId, o()));
    step((d) => tagObject(d, deviceId, 'core', o()));
    const tagId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Tag')!.id;
    step((d) => renameTag(d, tagId, 'edge', o()));
    step((d) => untagObject(d, deviceId, tagId, o()));

    step((d) => createShelf(d, rackId, { label: 'Shelf', positionU: 12, ...o() }));
    const shelfId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'PassiveNode')!.id;
    step((d) => setPassiveNodeField(d, shelfId, 'label', 'Shelf 2', o()));
    step((d) => resizeShelf(d, shelfId, { heightU: 2, slots: 2 }, { catalogue: [MODEL], ...o() }));
    step((d) => createSketchDevice(d, { hostname: 'box-1', ...o() }));
    const sketchChassis = freshNodes({ ...doc, nodes: [] }, doc, 'Chassis').find((c) => c !== chassisId && c !== chassis2)!;
    step((d) => placeOnShelf(d, sketchChassis, shelfId, 1, o()));
    step((d) => movePlacement(d, sketchChassis, { kind: 'rack', rackId, positionU: 18, face: 'front' }, o()));
    step((d) => addSketchPort(d, sketchChassis, { label: 'Et1', connector: 'rj45', face: 'front' }, o()));
    step((d) => addSketchPortRange(d, sketchChassis, { labelPrefix: 'Et', first: 2, last: 5, connector: 'rj45', face: 'front' }, o()));
    const sketchPort = edgesOut(doc, sketchChassis, 'HasPort')[0].to;
    step((d) => removeSketchPort(d, sketchChassis, sketchPort, o()));
    step((d) => duplicateDevice(d, chassisId, { catalogue: [MODEL], ...o() }).doc);

    step((d) => createSurface(d, premisesId, { label: 'North wall', form: 'wall', ...o() }));
    const surfaceId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Surface')!.id;
    step((d) => createBoard(d, surfaceId, { label: 'Backboard', ...o() }));
    const boardId = doc.nodes.find((n) => n.fields['PassiveNode.form']?.value === 'board')!.id;
    step((d) => movePlacement(d, sketchChassis, { kind: 'surface', surfaceId, xMm: 5, yMm: 6 }, o()));
    step((d) => movePlacement(d, sketchChassis, { kind: 'board', boardId, xMm: 7, yMm: 8 }, o()));
    step((d) => movePlacement(d, sketchChassis, { kind: 'rack', rackId, positionU: 19, face: 'front' }, o()));

    step((d) => createFreeBox(d, { x: 10, y: 20, role: 'router', hostname: 'rtr-1', ...o() }).doc);
    step((d) => createLabel(d, { text: 'hi', form: 'text', x: 1, y: 2, ...o() }).doc);
    const labelId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Label')!.id;
    step((d) => setLabel(d, labelId, { text: 'bye' }, o()));
    step((d) => moveFree(d, [{ id: labelId, x: 5, y: 6 }], o()));
    const line = createLine(doc, chassisId, chassis2, o());
    step(() => line.doc);
    step((d) => setLineLabel(d, line.id, 'uplink', o()));
    step((d) => setLineLabel(d, line.id, null, o()));
    step((d) => removeFree(d, [labelId], o()));

    step((d) => addVlan(d, { vlanId: 10, name: 'users', on: [deviceId] }, o()));

    // Undo and redo, including another person's later edit to a different field.
    step((d) => setDeviceField(d, deviceId, 'hostname', 'sw-9', o()));
    step((d) => setDeviceField(d, deviceId, 'hostname', 'sw-by-them', o(OTHER)));
    const mine = doc.batches[doc.batches.length - 2].id;
    step((d) => {
      try {
        return undo(d, mine, { actor: ME, now: (t += 1000) });
      } catch {
        return d;
      }
    });
    const lastMine = doc.batches.filter((b) => b.label === 'set Chassis.serial')[0].id;
    step((d) => undo(d, lastMine, { actor: ME, now: (t += 1000) }));
    const undone = doc.batches[doc.batches.length - 1].id;
    step((d) => redo(d, undone, { actor: ME, now: (t += 1000) }));
    const rm = removeChassis(doc, chassis2, o());
    step(() => rm);
    const removed = doc.batches[doc.batches.length - 1].id;
    step((d) => undo(d, removed, { actor: ME, now: (t += 1000) }));
    step((d) => undo(d, d.batches.find((b) => b.label === 'create rack')!.id, { actor: ME, now: (t += 1000) }));
  });

  it('applies a single change and changeOf agrees with changesOf', () => {
    const premisesId = formatNodeId('Premises', newUlid(NOW));
    const doc: Document = {
      ...emptyDocument(),
      nodes: [{ id: premisesId, existence: newUlid(NOW), fields: {} }],
    };
    const next = createRack(doc, premisesId, { label: 'R', heightU: 10, unitNumbering: 'ascending', actor: ME, now: NOW });
    expect(changeOf(doc, next)).toEqual(changesOf(doc, next)[0]);
    expect(() => changeOf(doc, doc)).toThrow(ChangeError);
  });
});

describe('applyChange refuses what cannot apply', () => {
  function base(): { doc: Document; rackId: string; change: Change; after: Document } {
    const premisesId = formatNodeId('Premises', newUlid(NOW));
    const doc: Document = { ...emptyDocument(), nodes: [{ id: premisesId, existence: newUlid(NOW), fields: {} }] };
    const after = createRack(doc, premisesId, { label: 'R', heightU: 10, unitNumbering: 'ascending', actor: ME, now: NOW });
    const rackId = after.nodes.find((n) => n.id !== premisesId)!.id;
    return { doc, rackId, change: changeOf(doc, after), after };
  }

  it('an edge from a node the document lacks', () => {
    const { change } = base();
    expect(() => applyChange(emptyDocument(), change)).toThrow(ChangeError);
  });

  it('leaves the input untouched', () => {
    const { doc, change } = base();
    const bad: Change = { ...change, values: change.values.slice(1) };
    const snapshot = JSON.stringify(doc);
    expect(() => applyChange(doc, bad)).toThrow(/no value/);
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('a reused batch, a reused node, an undeclared field, a surplus value', () => {
    const { doc, change, after } = base();
    expect(() => applyChange(after, change)).toThrow(ChangeError);
    expect(() => applyChange(doc, { ...change, values: [...change.values, 'x'] })).toThrow(/more values/);
    const badKey = { ...change, batch: { ...change.batch, ops: change.batch.ops.map((op) => (op.type === 'set_field' ? { ...op, key: 'Rack.nonsense' } : op)) } };
    expect(() => applyChange(doc, badKey)).toThrow(/field registry/);
    const noProv: Change = { ...change, provenance: [] };
    expect(() => applyChange(doc, noProv)).toThrow(ChangeError);
  });

  it('a set on an element that is not there', () => {
    const { doc, change } = base();
    const ghost = formatNodeId('Rack', newUlid(NOW + 5));
    const bad: Change = {
      ...change,
      batch: { ...change.batch, ops: [{ type: 'set_field', element: ghost, key: 'Rack.label', presence: 'absent', prov: change.provenance[0].id }] },
      provenance: [change.provenance[0]],
      values: [],
    };
    expect(() => applyChange(doc, bad)).toThrow(/is not in this document/);
    expect(findNode(doc, ghost)).toBeUndefined();
  });

  it('readChange refuses other bytes', () => {
    expect(() => readChange(new TextEncoder().encode('fathom-plain 1\n'))).toThrow(ChangeError);
    expect(() => readChange(new Uint8Array([1, 2, 3]))).toThrow(ChangeError);
  });
});
