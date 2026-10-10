import { describe, expect, it } from 'vitest';

import { createRack, createSketchDevice } from './commands';
import { foldIntoOneBatch, moveManyToRack, setRoleMany, tagMany, tagsOfMany, untagMany } from './bulk';
import { edgesOut, emptyDocument, formatNodeId, parseNodeId, type Document } from './model';
import { TagRefusalError, tagObject, tagsOf } from './tags';
import { undo } from './undo';
import { newUlid } from './ulid';
import { viewOf } from './view';

const NOW = 1_700_000_000_000;
const ACTOR = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function threeDevices(): { doc: Document; devices: string[]; chassis: string[] } {
  let doc = emptyDocument();
  const devices: string[] = [];
  const chassis: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const before = new Set(doc.nodes.map((n) => n.id));
    doc = createSketchDevice(doc, { now: NOW + i, actor: ACTOR });
    for (const n of doc.nodes) {
      if (before.has(n.id)) continue;
      const kind = parseNodeId(n.id).kind;
      if (kind === 'Device') devices.push(n.id);
      if (kind === 'Chassis') chassis.push(n.id);
    }
  }
  return { doc, devices, chassis };
}

describe('tagMany', () => {
  it('tags every device in one batch, and one undo takes it all back', () => {
    const { doc, devices } = threeDevices();
    const out = tagMany(doc, devices, 'lab', { actor: ACTOR, now: NOW + 10 });
    expect(out.batches.length).toBe(doc.batches.length + 1);
    for (const id of devices) expect(tagsOf(out, id).map((t) => t.name)).toEqual(['lab']);
    const undone = undo(out, out.batches.at(-1)!.id, { actor: ACTOR, now: NOW + 11 });
    for (const id of devices) expect(tagsOf(undone, id)).toHaveLength(0);
  });

  it('leaves a device that already carries the tag alone', () => {
    const { doc, devices } = threeDevices();
    const one = tagObject(doc, devices[0]!, 'lab', { actor: ACTOR, now: NOW + 10 });
    const out = tagMany(one, devices, 'LAB', { actor: ACTOR, now: NOW + 11 });
    for (const id of devices) expect(tagsOf(out, id)).toHaveLength(1);
  });

  it('refuses a blank name and changes nothing', () => {
    const { doc, devices } = threeDevices();
    expect(() => tagMany(doc, devices, '   ', { actor: ACTOR, now: NOW + 10 })).toThrow(TagRefusalError);
  });
});

describe('tagsOfMany and untagMany', () => {
  it('counts how many carry each tag, then removes it from all in one batch', () => {
    const { doc, devices } = threeDevices();
    const part = tagObject(doc, devices[0]!, 'lab', { actor: ACTOR, now: NOW + 10 });
    const both = tagObject(part, devices[1]!, 'lab', { actor: ACTOR, now: NOW + 11 });
    const chips = tagsOfMany(both, devices);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ name: 'lab', count: 2, total: 3 });
    const out = untagMany(both, devices, chips[0]!.tagId, { actor: ACTOR, now: NOW + 12 });
    expect(out.batches.length).toBe(both.batches.length + 1);
    for (const id of devices) expect(tagsOf(out, id)).toHaveLength(0);
  });
});

describe('setRoleMany', () => {
  it('sets the role on every device in one batch', () => {
    const { doc, devices } = threeDevices();
    const out = setRoleMany(doc, devices, 'switch', { actor: ACTOR, now: NOW + 10 });
    expect(out.batches.length).toBe(doc.batches.length + 1);
    const roles = devices.map((id) => out.nodes.find((n) => n.id === id)!.fields['Device.role']);
    expect(roles.every((r) => r?.presence === 'set' && r.value === 'switch')).toBe(true);
  });
});

describe('moveManyToRack', () => {
  it('moves several devices into a rack as one step', () => {
    const { doc: base, chassis } = threeDevices();
    const premisesId = formatNodeId('Premises', newUlid(NOW));
    const withPremises: Document = {
      ...base,
      nodes: [...base.nodes, { id: premisesId, existence: newUlid(NOW), fields: { 'Premises.label': { presence: 'set', prov: newUlid(NOW), value: 'P' } } }],
    };
    const withRack = createRack(withPremises, premisesId, { label: 'R1', heightU: 10, unitNumbering: 'ascending', now: NOW + 5, actor: ACTOR });
    const rackId = withRack.nodes.find((n) => parseNodeId(n.id).kind === 'Rack')!.id;
    const out = moveManyToRack(
      withRack,
      chassis.map((id, i) => ({ itemId: id, rackId, positionU: i + 1 })),
      { actor: ACTOR, now: NOW + 20 },
    );
    expect(out.batches.length).toBe(withRack.batches.length + 1);
    for (const id of chassis) expect(edgesOut(out, id, 'MountedIn')).toHaveLength(1);
    const view = viewOf(out, []);
    expect(view.racks[0]!.chassis.map((c) => c.positionU).sort()).toEqual([1, 2, 3]);
  });
});

describe('foldIntoOneBatch', () => {
  it('leaves a single batch alone', () => {
    const { doc } = threeDevices();
    expect(foldIntoOneBatch(doc, doc.batches.length, 'x')).toBe(doc);
  });
});
