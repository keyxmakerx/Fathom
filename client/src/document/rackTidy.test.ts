import { describe, expect, it } from 'vitest';
import { connectPorts } from './cables';
import { addSketchPortRange, createRack, createShelf, createSketchDevice, movePlacement } from './commands';
import {
  edgesIn,
  edgesOut,
  emptyDocument,
  findNode,
  formatNodeId,
  readDeviceFields,
  readMountedInFields,
  readPhysicalPortFields,
  readRackFields,
  type Document,
} from './model';
import { closeRackGaps, copyRack, nextRackLabel, rackGaps, suffixName } from './rackTidy';
import { newUlid } from './ulid';

const NOW = 1_700_000_000_000;

function rack(): { doc: Document; rackId: string } {
  const premisesId = formatNodeId('Premises', newUlid(NOW));
  const doc: Document = { ...emptyDocument(), nodes: [{ id: premisesId, existence: newUlid(NOW), fields: {} }] };
  const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 12, unitNumbering: 'ascending', now: NOW });
  return { doc: withRack, rackId: withRack.nodes.find((n) => n.id.startsWith('rack:'))!.id };
}

/** A named sketch box with two ports at `u` in `rackId`. */
function box(doc: Document, rackId: string, name: string, u: number, face: 'front' | 'rear' = 'front'): { doc: Document; chassisId: string } {
  const before = new Set(doc.nodes.map((n) => n.id));
  let d = createSketchDevice(doc, { hostname: name, now: NOW });
  const chassisId = d.nodes.find((n) => !before.has(n.id) && n.id.startsWith('chassis:'))!.id;
  d = movePlacement(d, chassisId, { kind: 'rack', rackId, positionU: u, face }, { now: NOW });
  d = addSketchPortRange(d, chassisId, { labelPrefix: 'eth', first: 0, last: 1, connector: 'rj45', face: 'front' }, { now: NOW });
  return { doc: d, chassisId };
}

const portOf = (doc: Document, chassisId: string, label: string) =>
  edgesOut(doc, chassisId, 'HasPort').find((e) => readPhysicalPortFields(findNode(doc, e.to)!).label === label)!.to;

const positions = (doc: Document, rackId: string) =>
  edgesIn(doc, rackId, 'MountedIn')
    .map((e) => readMountedInFields(e).positionU)
    .sort((a, b) => b! - a!);

describe('closeRackGaps', () => {
  it('packs everything under the top item, in order, as one batch', () => {
    let { doc, rackId } = rack();
    ({ doc } = box(doc, rackId, 'fw-01', 11));
    ({ doc } = box(doc, rackId, 'switch-1', 8));
    ({ doc } = box(doc, rackId, 'nas-1', 3, 'rear'));
    expect(rackGaps(doc, rackId)).toBe(6);
    const batches = doc.batches.length;
    const r = closeRackGaps(doc, rackId, { now: NOW });
    expect(r.moved).toBe(2);
    expect(positions(r.doc, rackId)).toEqual([11, 10, 9]);
    expect(rackGaps(r.doc, rackId)).toBe(0);
    expect(r.doc.batches).toHaveLength(batches + 1);
    // The rear-mounted box stays on the rear.
    const faces = edgesIn(r.doc, rackId, 'MountedIn').map((e) => readMountedInFields(e).face);
    expect(faces.filter((f) => f === 'rear')).toHaveLength(1);
  });

  it('keeps a tall item whole and changes nothing when there is no gap', () => {
    let { doc, rackId } = rack();
    ({ doc } = box(doc, rackId, 'a', 12));
    doc = createShelf(doc, rackId, { positionU: 5, label: 'Shelf', now: NOW });
    const r = closeRackGaps(doc, rackId, { now: NOW });
    expect(positions(r.doc, rackId)).toEqual([12, 11]);
    const again = closeRackGaps(r.doc, rackId, { now: NOW });
    expect(again.moved).toBe(0);
    expect(again.doc).toBe(r.doc);
  });
});

describe('copyRack', () => {
  it('copies the rack, its devices at the same units and the cables between them', () => {
    let { doc, rackId } = rack();
    let a: string;
    let b: string;
    let c: string;
    ({ doc, chassisId: a } = box(doc, rackId, 'fw-01', 11));
    ({ doc, chassisId: b } = box(doc, rackId, 'switch-1', 8));
    ({ doc, chassisId: c } = box(doc, rackId, 'nas-1', 3, 'rear'));
    doc = connectPorts(doc, portOf(doc, a, 'eth0'), portOf(doc, b, 'eth0'), { sheath: 'blue' }, { now: NOW });
    doc = connectPorts(doc, portOf(doc, b, 'eth1'), portOf(doc, c, 'eth0'), {}, { now: NOW });
    const batches = doc.batches.length;

    const r = copyRack(doc, rackId, { now: NOW });
    expect(r.label).toBe('R2');
    expect(r.devices).toBe(3);
    expect(r.cables).toBe(2);
    expect(r.doc.batches).toHaveLength(batches + 1);
    expect(readRackFields(findNode(r.doc, r.rackId)!).heightU).toBe(12);
    expect(positions(r.doc, r.rackId)).toEqual([11, 8, 3]);

    const copies = edgesIn(r.doc, r.rackId, 'MountedIn').map((e) => e.from);
    const names = copies.map((ch) => readDeviceFields(findNode(r.doc, edgesIn(r.doc, ch, 'HasChassis')[0]!.from)!).hostname).sort();
    expect(names).toEqual(['fw-01-2', 'nas-1-2', 'switch-1-2']);
    const rear = edgesIn(r.doc, r.rackId, 'MountedIn').filter((e) => readMountedInFields(e).face === 'rear');
    expect(rear).toHaveLength(1);

    // Every cable in the copy ends on copied ports, and the sheath came along.
    const copiedPorts = new Set(copies.flatMap((ch) => edgesOut(r.doc, ch, 'HasPort').map((e) => e.to)));
    const newCables = r.doc.nodes.filter((n) => n.id.startsWith('cable:') && !doc.nodes.some((o) => o.id === n.id));
    expect(newCables).toHaveLength(2);
    for (const cable of newCables) for (const t of edgesOut(r.doc, cable.id, 'Terminates')) expect(copiedPorts.has(t.to)).toBe(true);
    expect(newCables.map((n) => n.fields['Cable.sheath']?.value)).toContain('blue');
  });

  it('leaves out cables that leave the rack', () => {
    let { doc, rackId } = rack();
    let a: string;
    ({ doc, chassisId: a } = box(doc, rackId, 'a', 2));
    const other = createRack(doc, edgesIn(doc, rackId, 'HasRack')[0]!.from, { label: 'Other', heightU: 4, unitNumbering: 'ascending', now: NOW });
    const otherId = other.nodes.find((n) => n.id.startsWith('rack:') && n.id !== rackId)!.id;
    let b: string;
    ({ doc, chassisId: b } = box(other, otherId, 'b', 1));
    doc = connectPorts(doc, portOf(doc, a, 'eth0'), portOf(doc, b, 'eth0'), {}, { now: NOW });
    const r = copyRack(doc, rackId, { now: NOW });
    expect(r.cables).toBe(0);
    expect(r.devices).toBe(1);
  });
});

describe('names', () => {
  it('counts R1 on to R2 and suffixes names', () => {
    expect(nextRackLabel(new Set(['R1', 'R2']), 'R1')).toBe('R3');
    expect(nextRackLabel(new Set(['Core']), 'Core')).toBe('Core-2');
    expect(suffixName(new Set(['fw-01-2']), 'fw-01')).toBe('fw-01-3');
  });
});
