import { afterEach, describe, expect, it, vi } from 'vitest';

import { connectPorts } from '../../document/cables';
import {
  addSketchPort,
  createRack,
  createShelf,
  createSketchDevice,
  createSurface,
  movePlacement,
} from '../../document/commands';
import {
  emptyDocument,
  formatEdgeId,
  formatNodeId,
  parseNodeId,
  type Document,
} from '../../document/model';
import { addVlan } from '../../document/networks';
import { deriveNetworks } from '../../document/networks-derive';
import { listTags, tagObject } from '../../document/tags';
import { newUlid } from '../../document/ulid';
import { viewOf } from '../../document/view';
import type { ClosetView } from './contract';
import {
  availableCableGroupCandidates,
  CABLE_TYPE_GROUPS,
  cableGroupRefKey,
  cableTypeGroupOf,
  closetHiddenCableCount,
  computeCableDraw,
  defaultCableGroupsState,
  isAllShortcutLit,
  isCableGroupsFiltered,
  isNoneShortcutLit,
  loadCableGroupsState,
  migratedOrDefaultCableGroupsState,
  resolveCableGroup,
  resolveStoredGroups,
  saveCableGroupsState,
  withAllCablesShown,
  withAllShortcut,
  withCableHidden,
  withCableShown,
  withGroupAdded,
  withGroupRemoved,
  withGroupTicked,
  withHiddenCablesPruned,
  withNoneShortcut,
  type CableGroupRef,
  type ResolvedCableGroup,
  type StoredCableGroupsState,
} from './cableGroups';

const NOW = 1_700_000_000_000;

function merge(...docs: readonly Document[]): Document {
  return docs.reduce((acc, d) => ({
    ...emptyDocument(),
    nodes: [...acc.nodes, ...d.nodes],
    edges: [...acc.edges, ...d.edges],
    provenance: [...acc.provenance, ...d.provenance],
    batches: [...acc.batches, ...d.batches],
  }));
}

function viewFor(doc: Document): ClosetView {
  return viewOf(doc, []);
}

function tag(ref: ResolvedCableGroup['ref'], cableIds: readonly string[], dashedCableIds?: readonly string[]): Pick<ResolvedCableGroup, 'ref' | 'cableIds' | 'dashedCableIds'> {
  return { ref, cableIds: new Set(cableIds), dashedCableIds: dashedCableIds ? new Set(dashedCableIds) : undefined };
}

const TYPE_A: CableGroupRef = { kind: 'type', type: 'copper' };
const TYPE_B: CableGroupRef = { kind: 'type', type: 'fibre' };
const VLAN_A: CableGroupRef = { kind: 'vlan', vlanId: 30, nodeIds: ['vlan:a'] };

interface PlacedDevice {
  deviceId: string;
  chassisId: string;
  portIds: string[];
}

/** A rack, and every device this test places into it (a cable's ends only
 * resolve in `ClosetView.cables` once BOTH its ports sit on something
 * placed somewhere; an unmounted sketch device draws no real end at all).
 * One rack unit per device, front. */
class Rig {
  doc: Document;
  readonly premisesId: string;
  readonly rackId: string;
  private nextU = 1;
  private nextShelfU = 30;

  constructor() {
    this.premisesId = formatNodeId('Premises', newUlid(NOW));
    const withPremises: Document = {
      ...emptyDocument(),
      nodes: [{ id: this.premisesId, existence: newUlid(NOW), fields: { 'Premises.label': { presence: 'set', prov: newUlid(NOW), value: 'Test' } } }],
    };
    const withRack = createRack(withPremises, this.premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', now: NOW });
    this.rackId = withRack.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Rack')!.id;
    this.doc = withRack;
  }

  addDevice(labels: readonly string[], hostname = 'dev'): PlacedDevice {
    let doc = createSketchDevice(emptyDocument(), { now: NOW, hostname });
    const deviceId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Device')!.id;
    const chassisId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
    const portIds: string[] = [];
    for (const label of labels) {
      const before = new Set(doc.nodes.map((n) => n.id));
      doc = addSketchPort(doc, chassisId, { label, connector: 'rj45', face: 'front' }, { now: NOW });
      portIds.push(doc.nodes.find((n) => !before.has(n.id) && parseNodeId(n.id).kind === 'PhysicalPort')!.id);
    }
    this.doc = merge(this.doc, doc);
    this.doc = movePlacement(this.doc, chassisId, { kind: 'rack', rackId: this.rackId, positionU: this.nextU, face: 'front' }, { now: NOW });
    this.nextU += 1;
    return { deviceId, chassisId, portIds };
  }

  /** A device sat on a fresh shelf rather than mounted directly — the shape
   * `chassisDeviceIdIndex`'s document-wide `HasChassis` scan must reach the
   * same way it reaches a rack-mounted one. */
  addShelfDevice(labels: readonly string[], hostname = 'shelf-dev'): PlacedDevice {
    let doc = createSketchDevice(emptyDocument(), { now: NOW, hostname });
    const deviceId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Device')!.id;
    const chassisId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
    const portIds: string[] = [];
    for (const label of labels) {
      const before = new Set(doc.nodes.map((n) => n.id));
      doc = addSketchPort(doc, chassisId, { label, connector: 'rj45', face: 'front' }, { now: NOW });
      portIds.push(doc.nodes.find((n) => !before.has(n.id) && parseNodeId(n.id).kind === 'PhysicalPort')!.id);
    }
    this.doc = merge(this.doc, doc);
    const beforeShelf = new Set(this.doc.nodes.map((n) => n.id));
    this.doc = createShelf(this.doc, this.rackId, { positionU: this.nextShelfU, label: `shelf-${this.nextShelfU}`, now: NOW });
    const shelfId = this.doc.nodes.find((n) => !beforeShelf.has(n.id) && parseNodeId(n.id).kind === 'PassiveNode')!.id;
    this.nextShelfU += 1;
    this.doc = movePlacement(this.doc, chassisId, { kind: 'shelf', shelfId, slot: 0 }, { now: NOW });
    return { deviceId, chassisId, portIds };
  }

  connect(portA: string, portB: string, media?: string): void {
    this.doc = connectPorts(this.doc, portA, portB, media ? { media: media as never } : {}, { now: NOW });
  }
}

/** `a`'s port carrying VLAN `vlanId` untagged (access) and `b`'s port a
 * TRUNK member of the same numeric id — by field, the same shape
 * `networks-derive.test.ts`'s own "pasted interface" fixture builds, since
 * `attachToVlan` itself refuses to create a fresh trunk. One cable directly
 * between them. */
function trunkVlanScene(vlanId: number): { doc: Document; row: { vlanId: number; vlanNodeIds: string[] }; cableId: string } {
  const rig = new Rig();
  const a = rig.addDevice(['Et1'], 'sw-core');
  const b = rig.addDevice(['Et2'], 'sw-edge');
  rig.connect(a.portIds[0], b.portIds[0]);
  rig.doc = addVlan(rig.doc, { vlanId, name: 'cameras', attach: [{ target: { kind: 'port', portId: a.portIds[0], interfaceName: 'Et1' } }] }, { now: NOW });

  const ifaceId = formatNodeId('Interface', newUlid(NOW));
  const unitId = formatNodeId('LogicalUnit', newUlid(NOW));
  rig.doc = {
    ...rig.doc,
    nodes: [
      ...rig.doc.nodes,
      { id: ifaceId, existence: newUlid(NOW), fields: { 'Interface.name': { presence: 'set', prov: newUlid(NOW), value: 'Et2' } } },
      {
        id: unitId,
        existence: newUlid(NOW),
        fields: {
          'LogicalUnit.index': { presence: 'set', prov: newUlid(NOW), value: vlanId },
          'LogicalUnit.vlan_id': { presence: 'set', prov: newUlid(NOW), value: String(vlanId) },
        },
      },
    ],
    edges: [
      ...rig.doc.edges,
      { id: formatEdgeId('HasInterface', newUlid(NOW)), from: b.deviceId, to: ifaceId, prov: newUlid(NOW), fields: {} },
      { id: formatEdgeId('Occupies', newUlid(NOW)), from: ifaceId, to: b.portIds[0], prov: newUlid(NOW), fields: {} },
      { id: formatEdgeId('HasUnit', newUlid(NOW)), from: ifaceId, to: unitId, prov: newUlid(NOW), fields: {} },
    ],
  };

  const { vlanRows } = deriveNetworks(rig.doc);
  const row = vlanRows.find((r) => r.vlanId === vlanId)!;
  const cableId = rig.doc.nodes.find((n) => parseNodeId(n.id).kind === 'Cable' && n.absentSince === undefined)!.id;
  return { doc: rig.doc, row: { vlanId: row.vlanId, vlanNodeIds: row.vlanNodeIds }, cableId };
}

describe("cableTypeGroupOf — the Type group", () => {
  it('classifies every media token', () => {
    expect(cableTypeGroupOf('cat5e')).toBe('copper');
    expect(cableTypeGroupOf('cat6')).toBe('copper');
    expect(cableTypeGroupOf('cat6a')).toBe('copper');
    expect(cableTypeGroupOf('coax')).toBe('copper');
    expect(cableTypeGroupOf('virtual')).toBe('copper');
    expect(cableTypeGroupOf('other')).toBe('copper');
    expect(cableTypeGroupOf('')).toBe('copper'); // unset
    expect(cableTypeGroupOf('smf')).toBe('fibre');
    expect(cableTypeGroupOf('mmf')).toBe('fibre');
    expect(cableTypeGroupOf('twinax')).toBe('dac'); // DAC, not copper
    expect(cableTypeGroupOf('power')).toBe('power');
  });
});

describe('computeCableDraw — the draw rule in every state', () => {
  const ALL = ['c1', 'c2', 'c3', 'c4'];

  it('no group ticked, None off: every cable draws ("All")', () => {
    const { drawnIds } = computeCableDraw(ALL, new Set(), false, []);
    expect([...drawnIds].sort()).toEqual(ALL);
  });

  it('None on: nothing draws, even with a group that would otherwise match', () => {
    const { drawnIds } = computeCableDraw(ALL, new Set(), true, [tag(TYPE_A, ['c1'])]);
    expect(drawnIds.size).toBe(0);
  });

  it('one group ticked: only its cables draw', () => {
    const { drawnIds } = computeCableDraw(ALL, new Set(), false, [tag(TYPE_A, ['c1', 'c2'])]);
    expect([...drawnIds].sort()).toEqual(['c1', 'c2']);
  });

  it('two groups ticked: the union draws', () => {
    const { drawnIds } = computeCableDraw(ALL, new Set(), false, [tag(TYPE_A, ['c1']), tag(TYPE_B, ['c3'])]);
    expect([...drawnIds].sort()).toEqual(['c1', 'c3']);
  });

  it('a hidden cable never draws, overriding every group and "All"', () => {
    const allHidden = computeCableDraw(ALL, new Set(['c2']), false, []);
    expect([...allHidden.drawnIds].sort()).toEqual(['c1', 'c3', 'c4']);
    const groupHidden = computeCableDraw(ALL, new Set(['c1']), false, [tag(TYPE_A, ['c1', 'c2'])]);
    expect([...groupHidden.drawnIds].sort()).toEqual(['c2']);
  });

  it('a cable hidden one at a time never draws even under None', () => {
    const { drawnIds } = computeCableDraw(ALL, new Set(['c1']), true, []);
    expect(drawnIds.size).toBe(0);
  });

  it("a VLAN group's dashed cable draws dashed when no other ticked VLAN group carries it untagged", () => {
    const { drawnIds, dashedIds } = computeCableDraw(ALL, new Set(), false, [tag(VLAN_A, ['c1', 'c2'], ['c2'])]);
    expect([...drawnIds].sort()).toEqual(['c1', 'c2']);
    expect([...dashedIds]).toEqual(['c2']);
  });

  it('another ticked VLAN group that includes the cable untagged makes it solid', () => {
    const otherVlan: CableGroupRef = { kind: 'vlan', vlanId: 40, nodeIds: ['vlan:b'] };
    const { dashedIds } = computeCableDraw(ALL, new Set(), false, [tag(VLAN_A, ['c2'], ['c2']), tag(otherVlan, ['c2'])]);
    expect(dashedIds.size).toBe(0);
  });

  it('a ticked type group carrying the same cable untagged does NOT make a VLAN dash solid — "VLAN 30 plus Copper keeps the trunk dashed"', () => {
    const { drawnIds, dashedIds } = computeCableDraw(ALL, new Set(), false, [tag(VLAN_A, ['c2'], ['c2']), tag(TYPE_A, ['c2'])]);
    expect([...drawnIds].sort()).toEqual(['c2']);
    expect([...dashedIds]).toEqual(['c2']);
  });

  it('a ticked tag or device group never dashes a cable on its own', () => {
    const tagRef: CableGroupRef = { kind: 'tag', nodeId: 'tag:x' };
    const deviceRef: CableGroupRef = { kind: 'device', nodeId: 'chassis:x' };
    const { dashedIds } = computeCableDraw(ALL, new Set(), false, [tag(tagRef, ['c1']), tag(deviceRef, ['c1'])]);
    expect(dashedIds.size).toBe(0);
  });
});

describe('resolveCableGroup — membership per kind, scoped to this closet', () => {
  it("VLAN: cablesForVlan's cable, dashed through the trunk member", () => {
    const scene = trunkVlanScene(30);
    const view = viewFor(scene.doc);
    const resolved = resolveCableGroup(scene.doc, view, { kind: 'vlan', vlanId: scene.row.vlanId, nodeIds: scene.row.vlanNodeIds });
    expect(resolved).not.toBeNull();
    expect(resolved!.kindLabel).toBe('VLAN');
    expect(resolved!.name).toBe('VLAN 30 · cameras');
    expect(resolved!.cableIds.has(scene.cableId)).toBe(true);
    expect(resolved!.dashedCableIds?.has(scene.cableId)).toBe(true);
  });

  it('VLAN: resolves by a shared member node id even after the row key would have changed', () => {
    const scene = trunkVlanScene(30);
    // A stale nodeIds subset (only the first member) still shares an id with
    // the live row, so it still resolves — surviving a join/split the same
    // way a stale ref must.
    const resolved = resolveCableGroup(scene.doc, viewFor(scene.doc), {
      kind: 'vlan',
      vlanId: scene.row.vlanId,
      nodeIds: [scene.row.vlanNodeIds[0]],
    });
    expect(resolved).not.toBeNull();
  });

  it('VLAN: falls back to the only row with that number when no member id survives', () => {
    const scene = trunkVlanScene(30);
    const resolved = resolveCableGroup(scene.doc, viewFor(scene.doc), { kind: 'vlan', vlanId: 30, nodeIds: ['vlan:gone'] });
    expect(resolved).not.toBeNull();
  });

  it('TAG: a cable tagged directly, a cable through a tagged port, a cable through a tagged device — rack-mounted and shelf-mounted alike', () => {
    const rig = new Rig();
    const cableA = rig.addDevice(['Et1'], 'cable-a');
    const cableB = rig.addDevice(['Et1'], 'cable-b');
    const portA = rig.addDevice(['Et1'], 'port-a');
    const portB = rig.addDevice(['Et1'], 'port-b');
    const deviceA = rig.addDevice(['Et1'], 'device-a');
    const deviceB = rig.addDevice(['Et1'], 'device-b');
    const shelfA = rig.addShelfDevice(['Et1'], 'shelf-a');
    const shelfB = rig.addDevice(['Et1'], 'shelf-b');
    rig.connect(cableA.portIds[0], cableB.portIds[0]);
    rig.connect(portA.portIds[0], portB.portIds[0]);
    rig.connect(deviceA.portIds[0], deviceB.portIds[0]);
    rig.connect(shelfA.portIds[0], shelfB.portIds[0]);

    const view0 = viewFor(rig.doc);
    const directCableId = view0.cables.find((c) => c.ends.some((e) => 'portId' in e && e.chassisId === cableA.chassisId))!.id;
    const viaPortCableId = view0.cables.find((c) => c.ends.some((e) => 'portId' in e && e.portId === portA.portIds[0]))!.id;
    const viaDeviceCableId = view0.cables.find((c) => c.ends.some((e) => 'portId' in e && e.chassisId === deviceA.chassisId))!.id;
    const viaShelfDeviceCableId = view0.cables.find((c) => c.ends.some((e) => 'portId' in e && e.chassisId === shelfA.chassisId))!.id;

    let doc = rig.doc;
    doc = tagObject(doc, directCableId, 'uplinks', { now: NOW });
    doc = tagObject(doc, portA.portIds[0], 'uplinks', { now: NOW });
    doc = tagObject(doc, deviceA.deviceId, 'uplinks', { now: NOW });
    doc = tagObject(doc, shelfA.deviceId, 'uplinks', { now: NOW });

    const view = viewFor(doc);
    const tagId = listTags(doc).find((t) => t.name === 'uplinks')!.id;
    const resolved = resolveCableGroup(doc, view, { kind: 'tag', nodeId: tagId });
    expect(resolved).not.toBeNull();
    expect(resolved!.kindLabel).toBe('TAG');
    expect(resolved!.cableIds.has(directCableId)).toBe(true);
    expect(resolved!.cableIds.has(viaPortCableId)).toBe(true);
    expect(resolved!.cableIds.has(viaDeviceCableId)).toBe(true);
    expect(resolved!.cableIds.has(viaShelfDeviceCableId)).toBe(true);
    expect(resolved!.cableIds.size).toBe(4);
  });

  it('a tag placed on a surface fixture device catches its cable too', () => {
    const rig = new Rig();
    const other = rig.addDevice(['Et1'], 'other');

    let doc = createSurface(rig.doc, rig.premisesId, { form: 'wall', label: 'Wall A', now: NOW });
    const surfaceId = doc.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Surface')!.id;

    let fixtureDoc = createSketchDevice(emptyDocument(), { now: NOW, hostname: 'wall-ont' });
    const fixtureDeviceId = fixtureDoc.nodes.find((n) => parseNodeId(n.id).kind === 'Device')!.id;
    const fixtureChassisId = fixtureDoc.nodes.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
    const before = new Set(fixtureDoc.nodes.map((n) => n.id));
    fixtureDoc = addSketchPort(fixtureDoc, fixtureChassisId, { label: 'Et1', connector: 'rj45', face: 'front' }, { now: NOW });
    const fixturePortId = fixtureDoc.nodes.find((n) => !before.has(n.id) && parseNodeId(n.id).kind === 'PhysicalPort')!.id;

    doc = merge(doc, fixtureDoc);
    doc = movePlacement(doc, fixtureChassisId, { kind: 'surface', surfaceId, xMm: 0, yMm: 0 }, { now: NOW });
    doc = connectPorts(doc, fixturePortId, other.portIds[0], {}, { now: NOW });
    doc = tagObject(doc, fixtureDeviceId, 'wall', { now: NOW });

    const view = viewFor(doc);
    const cableId = view.cables.find((c) => c.ends.some((e) => 'portId' in e && e.portId === fixturePortId))!.id;
    const tagId = listTags(doc).find((t) => t.name === 'wall')!.id;
    const resolved = resolveCableGroup(doc, view, { kind: 'tag', nodeId: tagId });
    expect(resolved!.cableIds.has(cableId)).toBe(true);
  });

  it('TYPE: twinax is DAC, not copper', () => {
    const rig = new Rig();
    const a = rig.addDevice(['Et1']);
    const b = rig.addDevice(['Et1']);
    rig.connect(a.portIds[0], b.portIds[0], 'twinax');
    const view = viewFor(rig.doc);
    const cableId = rig.doc.nodes.find((n) => parseNodeId(n.id).kind === 'Cable' && n.absentSince === undefined)!.id;
    const dac = resolveCableGroup(rig.doc, view, { kind: 'type', type: 'dac' })!;
    expect(dac.cableIds.has(cableId)).toBe(true);
    const copper = resolveCableGroup(rig.doc, view, { kind: 'type', type: 'copper' })!;
    expect(copper.cableIds.has(cableId)).toBe(false);
  });

  it("DEVICE: every cable with an end on that device's ports", () => {
    const rig = new Rig();
    const a = rig.addDevice(['Et1', 'Et2']);
    const b = rig.addDevice(['Et1']);
    const c = rig.addDevice(['Et1']);
    rig.connect(a.portIds[0], b.portIds[0]);
    rig.connect(a.portIds[1], c.portIds[0]);
    const view = viewFor(rig.doc);
    const resolved = resolveCableGroup(rig.doc, view, { kind: 'device', nodeId: a.chassisId })!;
    expect(resolved.cableIds.size).toBe(2);
    expect(resolved.kindLabel).toBe('DEVICE');
  });
});

describe('references that resolve and ones that drop', () => {
  it('a VLAN row still present resolves; a removed one does not', () => {
    const rig = new Rig();
    const { deviceId } = rig.addDevice([]);
    rig.doc = addVlan(rig.doc, { vlanId: 40, on: [deviceId] }, { now: NOW });
    const view = viewFor(rig.doc);
    const row = deriveNetworks(rig.doc).vlanRows[0];
    expect(resolveCableGroup(rig.doc, view, { kind: 'vlan', vlanId: row.vlanId, nodeIds: row.vlanNodeIds })).not.toBeNull();
    expect(resolveCableGroup(rig.doc, view, { kind: 'vlan', vlanId: 999, nodeIds: ['vlan:does-not-exist'] })).toBeNull();
  });

  it('a tag still live resolves; an unknown node id does not', () => {
    const rig = new Rig();
    const { deviceId } = rig.addDevice([]);
    const doc = tagObject(rig.doc, deviceId, 'core', { now: NOW });
    const view = viewFor(doc);
    const tagId = listTags(doc).find((t) => t.name === 'core')!.id;
    expect(resolveCableGroup(doc, view, { kind: 'tag', nodeId: tagId })).not.toBeNull();
    expect(resolveCableGroup(doc, view, { kind: 'tag', nodeId: 'tag:gone' })).toBeNull();
  });

  it('a device still placed resolves; an unknown node id does not', () => {
    const rig = new Rig();
    const { chassisId } = rig.addDevice(['Et1']);
    const view = viewFor(rig.doc);
    expect(resolveCableGroup(rig.doc, view, { kind: 'device', nodeId: chassisId })).not.toBeNull();
    expect(resolveCableGroup(rig.doc, view, { kind: 'device', nodeId: 'chassis:gone' })).toBeNull();
  });

  it('resolveStoredGroups drops an unresolved reference, keeps the rest, and returns a state with the drop already applied', () => {
    const rig = new Rig();
    const { deviceId, chassisId } = rig.addDevice([]);
    rig.doc = addVlan(rig.doc, { vlanId: 40, on: [deviceId] }, { now: NOW });
    const view = viewFor(rig.doc);
    const row = deriveNetworks(rig.doc).vlanRows[0];
    const state: StoredCableGroupsState = {
      groups: [
        { ref: { kind: 'vlan', vlanId: row.vlanId, nodeIds: row.vlanNodeIds }, on: true },
        { ref: { kind: 'device', nodeId: 'chassis:gone' }, on: false },
        { ref: { kind: 'device', nodeId: chassisId }, on: false },
      ],
      none: false,
      hiddenCableIds: [],
    };
    const { state: nextState, rows, droppedRefKeys } = resolveStoredGroups(rig.doc, view, state);
    expect(rows).toHaveLength(2);
    expect(droppedRefKeys).toEqual([cableGroupRefKey({ kind: 'device', nodeId: 'chassis:gone' })]);
    expect(nextState).not.toBe(state);
    expect(nextState.groups).toHaveLength(2);
    expect(nextState.groups.some((g) => g.ref.kind === 'device' && g.ref.nodeId === 'chassis:gone')).toBe(false);
  });

  it('resolveStoredGroups returns the SAME state object when nothing dropped', () => {
    const rig = new Rig();
    const { chassisId } = rig.addDevice(['Et1']);
    const view = viewFor(rig.doc);
    const state: StoredCableGroupsState = { groups: [{ ref: { kind: 'device', nodeId: chassisId }, on: false }], none: false, hiddenCableIds: [] };
    const { state: nextState } = resolveStoredGroups(rig.doc, view, state);
    expect(nextState).toBe(state);
  });
});

describe('the old choice carried over — once for the whole browser', () => {
  afterEach(() => vi.unstubAllGlobals());

  class FakeStorage implements Partial<Storage> {
    private store = new Map<string, string>();
    getItem(key: string): string | null {
      return this.store.has(key) ? this.store.get(key)! : null;
    }
    setItem(key: string, value: string): void {
      this.store.set(key, value);
    }
    removeItem(key: string): void {
      this.store.delete(key);
    }
  }

  it('copper/fibre/power becomes that type group, ticked', () => {
    vi.stubGlobal('localStorage', new FakeStorage());
    localStorage.setItem('fathom.drawing.cableVisibility', 'fibre');
    const rig = new Rig();
    const a = rig.addDevice(['Et1']);
    const b = rig.addDevice(['Et1']);
    rig.connect(a.portIds[0], b.portIds[0]);
    const view = viewFor(rig.doc);
    const migrated = migratedOrDefaultCableGroupsState(view);
    expect(migrated.none).toBe(false);
    const fibre = migrated.groups.find((g) => g.ref.kind === 'type' && g.ref.type === 'fibre');
    expect(fibre?.on).toBe(true);
  });

  it('none becomes None', () => {
    vi.stubGlobal('localStorage', new FakeStorage());
    localStorage.setItem('fathom.drawing.cableVisibility', 'none');
    const view: ClosetView = viewFor(emptyDocument());
    const migrated = migratedOrDefaultCableGroupsState(view);
    expect(migrated.none).toBe(true);
    expect(migrated.groups.every((g) => !g.on)).toBe(true);
  });

  it('the key is removed after the first read — a second design finds nothing left to carry over', () => {
    vi.stubGlobal('localStorage', new FakeStorage());
    localStorage.setItem('fathom.drawing.cableVisibility', 'fibre');
    const view: ClosetView = viewFor(emptyDocument());
    migratedOrDefaultCableGroupsState(view);
    expect(localStorage.getItem('fathom.drawing.cableVisibility')).toBeNull();
    const second = migratedOrDefaultCableGroupsState(view);
    expect(second).toEqual(defaultCableGroupsState(view));
  });

  it('nothing stored at all is the plain default', () => {
    vi.stubGlobal('localStorage', new FakeStorage());
    const view: ClosetView = viewFor(emptyDocument());
    expect(migratedOrDefaultCableGroupsState(view)).toEqual(defaultCableGroupsState(view));
  });
});

describe('defaultCableGroupsState — "the types that occur in this closet, all unticked"', () => {
  it('lists only the types actually present, every one unticked', () => {
    const rig = new Rig();
    const a = rig.addDevice(['Et1']);
    const b = rig.addDevice(['Et1']);
    rig.connect(a.portIds[0], b.portIds[0], 'smf');
    const view = viewFor(rig.doc);
    const state = defaultCableGroupsState(view);
    expect(state.groups.map((g) => g.ref)).toEqual([{ kind: 'type', type: 'fibre' }]);
    expect(state.groups.every((g) => !g.on)).toBe(true);
    expect(state.none).toBe(false);
    expect(state.hiddenCableIds).toEqual([]);
  });

  it('an empty view lists no types at all', () => {
    expect(defaultCableGroupsState(viewFor(emptyDocument())).groups).toEqual([]);
  });
});

describe('availableCableGroupCandidates', () => {
  it('offers every type even with none present, plus VLANs/tags/devices that exist, each with a name', () => {
    const rig = new Rig();
    const { deviceId } = rig.addDevice([]);
    rig.doc = addVlan(rig.doc, { vlanId: 10, on: [deviceId] }, { now: NOW });
    const doc = tagObject(rig.doc, deviceId, 'core', { now: NOW });
    const view = viewFor(doc);
    const candidates = availableCableGroupCandidates(doc, view);
    for (const t of CABLE_TYPE_GROUPS) expect(candidates).toContainEqual({ ref: { kind: 'type', type: t }, kindLabel: 'TYPE', name: expect.any(String) });
    expect(candidates.some((c) => c.ref.kind === 'vlan')).toBe(true);
    const tagId = listTags(doc).find((t) => t.name === 'core')!.id;
    expect(candidates.some((c) => c.ref.kind === 'tag' && c.ref.nodeId === tagId && c.name === 'core')).toBe(true);
  });
});

describe('loadCableGroupsState/saveCableGroupsState — per design, wrapped in try/catch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  class FakeStorage implements Partial<Storage> {
    private store = new Map<string, string>();
    getItem(key: string): string | null {
      return this.store.has(key) ? this.store.get(key)! : null;
    }
    setItem(key: string, value: string): void {
      this.store.set(key, value);
    }
  }

  it('round-trips a saved state', () => {
    vi.stubGlobal('localStorage', new FakeStorage());
    const state: StoredCableGroupsState = {
      groups: [{ ref: { kind: 'type', type: 'copper' }, on: true }],
      none: false,
      hiddenCableIds: ['cable:1'],
    };
    saveCableGroupsState('design-a', state);
    expect(loadCableGroupsState('design-a')).toEqual(state);
  });

  it('two designs keep separate keys', () => {
    vi.stubGlobal('localStorage', new FakeStorage());
    saveCableGroupsState('design-a', { groups: [], none: true, hiddenCableIds: [] });
    expect(loadCableGroupsState('design-b')).toBeNull();
  });

  it('nothing stored returns null, not a thrown error', () => {
    vi.stubGlobal('localStorage', new FakeStorage());
    expect(loadCableGroupsState('design-a')).toBeNull();
  });

  it('a throwing localStorage.getItem falls back to null rather than throwing', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    expect(loadCableGroupsState('design-a')).toBeNull();
  });

  it('a throwing localStorage.setItem is swallowed', () => {
    vi.stubGlobal('localStorage', {
      setItem: () => {
        throw new Error('quota');
      },
    });
    expect(() => saveCableGroupsState('design-a', { groups: [], none: false, hiddenCableIds: [] })).not.toThrow();
  });

  it('a malformed stored value falls back to null rather than a garbage shape', () => {
    vi.stubGlobal('localStorage', new FakeStorage());
    localStorage.setItem('fathom.cables.design-a', JSON.stringify({ groups: 'nope' }));
    expect(loadCableGroupsState('design-a')).toBeNull();
  });
});

describe('state transitions', () => {
  const BASE: StoredCableGroupsState = {
    groups: [
      { ref: { kind: 'type', type: 'copper' }, on: false },
      { ref: { kind: 'type', type: 'fibre' }, on: true },
    ],
    none: false,
    hiddenCableIds: [],
  };

  it('All unticks every group and turns None off', () => {
    const withNone = { ...BASE, none: true };
    const next = withAllShortcut(withNone);
    expect(next.none).toBe(false);
    expect(next.groups.every((g) => !g.on)).toBe(true);
    expect(isAllShortcutLit(next)).toBe(true);
  });

  it('None unticks every group and turns None on', () => {
    const next = withNoneShortcut(BASE);
    expect(next.none).toBe(true);
    expect(next.groups.every((g) => !g.on)).toBe(true);
    expect(isNoneShortcutLit(next)).toBe(true);
  });

  it('ticking a group turns None off', () => {
    const noned = withNoneShortcut(BASE);
    const key = cableGroupRefKey({ kind: 'type', type: 'copper' });
    const next = withGroupTicked(noned, key, true);
    expect(next.none).toBe(false);
    expect(next.groups.find((g) => cableGroupRefKey(g.ref) === key)?.on).toBe(true);
  });

  it('withGroupAdded never duplicates an existing reference', () => {
    const added = withGroupAdded(BASE, { kind: 'type', type: 'fibre' });
    expect(added).toBe(BASE); // no change at all
    const withDevice = withGroupAdded(BASE, { kind: 'device', nodeId: 'chassis:x' });
    expect(withDevice.groups).toHaveLength(3);
    expect(withDevice.groups[2]).toEqual({ ref: { kind: 'device', nodeId: 'chassis:x' }, on: false });
  });

  it('withGroupRemoved drops exactly that reference', () => {
    const key = cableGroupRefKey({ kind: 'type', type: 'fibre' });
    const next = withGroupRemoved(BASE, key);
    expect(next.groups).toEqual([{ ref: { kind: 'type', type: 'copper' }, on: false }]);
  });

  it('hide/show one cable at a time, and "show" for every one at once', () => {
    const hidden = withCableHidden(BASE, 'cable:1');
    expect(hidden.hiddenCableIds).toEqual(['cable:1']);
    expect(withCableHidden(hidden, 'cable:1')).toBe(hidden); // no duplicate
    const shown = withCableShown(hidden, 'cable:1');
    expect(shown.hiddenCableIds).toEqual([]);
    const manyHidden = withCableHidden(withCableHidden(BASE, 'cable:1'), 'cable:2');
    expect(withAllCablesShown(manyHidden).hiddenCableIds).toEqual([]);
  });

  it('isCableGroupsFiltered: true under None, a ticked group, or a hidden cable; false otherwise', () => {
    expect(isCableGroupsFiltered(defaultCableGroupsState(viewFor(emptyDocument())))).toBe(false);
    expect(isCableGroupsFiltered(withNoneShortcut(BASE))).toBe(true);
    expect(isCableGroupsFiltered(BASE)).toBe(true); // fibre already ticked
    expect(isCableGroupsFiltered(withCableHidden(withAllShortcut(BASE), 'cable:1'))).toBe(true);
  });

  it('withHiddenCablesPruned drops a hidden id whose cable no longer exists, unchanged otherwise', () => {
    const hidden = withCableHidden(withCableHidden(BASE, 'cable:1'), 'cable:2');
    const pruned = withHiddenCablesPruned(hidden, new Set(['cable:1']));
    expect(pruned.hiddenCableIds).toEqual(['cable:1']);
    expect(withHiddenCablesPruned(hidden, new Set(['cable:1', 'cable:2']))).toBe(hidden);
  });
});

describe('closetHiddenCableCount', () => {
  it('counts only the hidden ids that are actually in this closet', () => {
    const rig = new Rig();
    const a = rig.addDevice(['Et1']);
    const b = rig.addDevice(['Et1']);
    rig.connect(a.portIds[0], b.portIds[0]);
    const view = viewFor(rig.doc);
    const realCableId = view.cables[0].id;
    expect(closetHiddenCableCount(view, [realCableId, 'cable:elsewhere'])).toBe(1);
  });
});
