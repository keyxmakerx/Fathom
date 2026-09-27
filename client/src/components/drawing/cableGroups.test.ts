import { afterEach, describe, expect, it, vi } from 'vitest';

import { connectPorts } from '../../document/cables';
import { addSketchPort, createRack, createSketchDevice, movePlacement } from '../../document/commands';
import {
  emptyDocument,
  formatEdgeId,
  formatNodeId,
  parseNodeId,
  type Document,
} from '../../document/model';
import { addVlan } from '../../document/networks';
import { deriveNetworks } from '../../document/networks-derive';
import { foldTagName, tagObject } from '../../document/tags';
import { newUlid } from '../../document/ulid';
import { viewOf } from '../../document/view';
import type { ClosetView } from './contract';
import {
  availableCableGroupRefs,
  CABLE_TYPE_GROUPS,
  cableGroupRefKey,
  cableGroupsStateFromOldVisibility,
  cableTypeGroupOf,
  computeCableDraw,
  defaultCableGroupsState,
  isAllShortcutLit,
  isCableGroupsFiltered,
  isNoneShortcutLit,
  loadCableGroupsState,
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
  withNoneShortcut,
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

interface PlacedDevice {
  deviceId: string;
  chassisId: string;
  portIds: string[];
}

/** A rack, and every device this test places into it (a cable's ends only
 * resolve in `ClosetView.cables` — `document/view.ts`'s own `cableEnd` —
 * once BOTH its ports sit on something placed somewhere; an unmounted sketch
 * device draws no real end at all). One rack unit per device, front. */
class Rig {
  doc: Document;
  private readonly rackId: string;
  private nextU = 1;

  constructor() {
    const premisesId = formatNodeId('Premises', newUlid(NOW));
    const withPremises: Document = {
      ...emptyDocument(),
      nodes: [{ id: premisesId, existence: newUlid(NOW), fields: { 'Premises.label': { presence: 'set', prov: newUlid(NOW), value: 'Test' } } }],
    };
    const withRack = createRack(withPremises, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', now: NOW });
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

  connect(portA: string, portB: string, media?: string): void {
    this.doc = connectPorts(this.doc, portA, portB, media ? { media: media as never } : {}, { now: NOW });
  }
}

/** `a`'s port carrying VLAN `vlanId` untagged (access) and `b`'s port a
 * TRUNK member of the same numeric id — by field, the same shape
 * `networks-derive.test.ts`'s own "pasted interface" fixture builds, since
 * `attachToVlan` itself refuses to create a fresh trunk (`networks.ts`: "a
 * trunk is never made here"). One cable directly between them. */
function trunkVlanScene(vlanId: number): { doc: Document; vlanKey: string; cableId: string } {
  const rig = new Rig();
  const a = rig.addDevice(['Et1'], 'sw-core');
  const b = rig.addDevice(['Et2'], 'sw-edge');
  rig.connect(a.portIds[0], b.portIds[0]);
  rig.doc = addVlan(rig.doc, { vlanId, name: 'cameras', attach: [{ target: { kind: 'port', portId: a.portIds[0], interfaceName: 'Et1' } }] }, { now: NOW });

  // The raw trunk unit on b's port — `LogicalUnit.vlan_id` alone marks it a
  // trunk carrier (`networks-derive.ts`'s own `unitCarries`), no `VlanMember`
  // edge required.
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
  return { doc: rig.doc, vlanKey: row.key, cableId };
}

describe("cableTypeGroupOf — decision 5's Type group", () => {
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
    const { drawnIds } = computeCableDraw(ALL, new Set(), true, [{ cableIds: new Set(['c1']) }]);
    expect(drawnIds.size).toBe(0);
  });

  it('one group ticked: only its cables draw', () => {
    const { drawnIds } = computeCableDraw(ALL, new Set(), false, [{ cableIds: new Set(['c1', 'c2']) }]);
    expect([...drawnIds].sort()).toEqual(['c1', 'c2']);
  });

  it('two groups ticked: the union draws', () => {
    const { drawnIds } = computeCableDraw(ALL, new Set(), false, [
      { cableIds: new Set(['c1']) },
      { cableIds: new Set(['c3']) },
    ]);
    expect([...drawnIds].sort()).toEqual(['c1', 'c3']);
  });

  it('a hidden cable never draws, overriding every group and "All"', () => {
    const allHidden = computeCableDraw(ALL, new Set(['c2']), false, []);
    expect([...allHidden.drawnIds].sort()).toEqual(['c1', 'c3', 'c4']);
    const groupHidden = computeCableDraw(ALL, new Set(['c1']), false, [{ cableIds: new Set(['c1', 'c2']) }]);
    expect([...groupHidden.drawnIds].sort()).toEqual(['c2']);
  });

  it('a cable hidden one at a time never draws even under None', () => {
    const { drawnIds } = computeCableDraw(ALL, new Set(['c1']), true, []);
    expect(drawnIds.size).toBe(0);
  });

  it("a VLAN group's dashed cable draws dashed when no other ticked group carries it untagged", () => {
    const { drawnIds, dashedIds } = computeCableDraw(ALL, new Set(), false, [
      { cableIds: new Set(['c1', 'c2']), dashedCableIds: new Set(['c2']) },
    ]);
    expect([...drawnIds].sort()).toEqual(['c1', 'c2']);
    expect([...dashedIds]).toEqual(['c2']);
  });

  it('another ticked group that includes the cable untagged makes it solid', () => {
    const { dashedIds } = computeCableDraw(ALL, new Set(), false, [
      { cableIds: new Set(['c2']), dashedCableIds: new Set(['c2']) },
      { cableIds: new Set(['c2']) }, // a type/tag/device group carrying c2 plainly
    ]);
    expect(dashedIds.size).toBe(0);
  });
});

describe('resolveCableGroup — membership per kind', () => {
  it("VLAN: cablesCarryingVlan's cable, dashed through the trunk member", () => {
    const scene = trunkVlanScene(30);
    const view = viewFor(scene.doc);
    const resolved = resolveCableGroup(scene.doc, view, { kind: 'vlan', key: scene.vlanKey });
    expect(resolved).not.toBeNull();
    expect(resolved!.kindLabel).toBe('VLAN');
    expect(resolved!.name).toBe('VLAN 30 · cameras');
    expect(resolved!.cableIds.has(scene.cableId)).toBe(true);
    expect(resolved!.dashedCableIds?.has(scene.cableId)).toBe(true);
  });

  it('TAG: a cable tagged directly, a cable through a tagged port, a cable through a tagged device', () => {
    // Three independent cabled pairs, each untagged to start — the tag
    // lands on a different kind of object beside each one.
    const rig = new Rig();
    const cableA = rig.addDevice(['Et1'], 'cable-a');
    const cableB = rig.addDevice(['Et1'], 'cable-b');
    const portA = rig.addDevice(['Et1'], 'port-a');
    const portB = rig.addDevice(['Et1'], 'port-b');
    const deviceA = rig.addDevice(['Et1'], 'device-a');
    const deviceB = rig.addDevice(['Et1'], 'device-b');
    rig.connect(cableA.portIds[0], cableB.portIds[0]);
    rig.connect(portA.portIds[0], portB.portIds[0]);
    rig.connect(deviceA.portIds[0], deviceB.portIds[0]);

    const view0 = viewFor(rig.doc);
    const directCableId = view0.cables.find((c) => c.ends.some((e) => 'portId' in e && e.chassisId === cableA.chassisId))!.id;
    const viaPortCableId = view0.cables.find((c) => c.ends.some((e) => 'portId' in e && e.portId === portA.portIds[0]))!.id;
    const viaDeviceCableId = view0.cables.find((c) => c.ends.some((e) => 'portId' in e && e.chassisId === deviceA.chassisId))!.id;

    let doc = rig.doc;
    doc = tagObject(doc, directCableId, 'uplinks', { now: NOW });
    doc = tagObject(doc, portA.portIds[0], 'uplinks', { now: NOW });
    doc = tagObject(doc, deviceA.deviceId, 'uplinks', { now: NOW });

    const view = viewFor(doc);
    const resolved = resolveCableGroup(doc, view, { kind: 'tag', fold: foldTagName('uplinks') });
    expect(resolved).not.toBeNull();
    expect(resolved!.kindLabel).toBe('TAG');
    expect(resolved!.cableIds.has(directCableId)).toBe(true);
    expect(resolved!.cableIds.has(viaPortCableId)).toBe(true);
    expect(resolved!.cableIds.has(viaDeviceCableId)).toBe(true);
    expect(resolved!.cableIds.size).toBe(3);
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
    expect(resolveCableGroup(rig.doc, view, { kind: 'vlan', key: row.key })).not.toBeNull();
    expect(resolveCableGroup(rig.doc, view, { kind: 'vlan', key: 'vlan:does-not-exist' })).toBeNull();
  });

  it('a tag still live resolves; an unknown fold does not', () => {
    const rig = new Rig();
    const { deviceId } = rig.addDevice([]);
    rig.doc = tagObject(rig.doc, deviceId, 'core', { now: NOW });
    const view = viewFor(rig.doc);
    expect(resolveCableGroup(rig.doc, view, { kind: 'tag', fold: foldTagName('core') })).not.toBeNull();
    expect(resolveCableGroup(rig.doc, view, { kind: 'tag', fold: 'no-such-fold' })).toBeNull();
  });

  it('a device still placed resolves; an unknown node id does not', () => {
    const rig = new Rig();
    const { chassisId } = rig.addDevice(['Et1']);
    const view = viewFor(rig.doc);
    expect(resolveCableGroup(rig.doc, view, { kind: 'device', nodeId: chassisId })).not.toBeNull();
    expect(resolveCableGroup(rig.doc, view, { kind: 'device', nodeId: 'chassis:gone' })).toBeNull();
  });

  it('resolveStoredGroups drops an unresolved reference and keeps the rest', () => {
    const rig = new Rig();
    const { deviceId, chassisId } = rig.addDevice([]);
    rig.doc = addVlan(rig.doc, { vlanId: 40, on: [deviceId] }, { now: NOW });
    const view = viewFor(rig.doc);
    const row = deriveNetworks(rig.doc).vlanRows[0];
    const state: StoredCableGroupsState = {
      groups: [
        { ref: { kind: 'vlan', key: row.key }, on: true },
        { ref: { kind: 'device', nodeId: 'chassis:gone' }, on: false },
        { ref: { kind: 'device', nodeId: chassisId }, on: false },
      ],
      none: false,
      hiddenCableIds: [],
    };
    const { rows, droppedRefKeys } = resolveStoredGroups(rig.doc, view, state);
    expect(rows).toHaveLength(2);
    expect(droppedRefKeys).toEqual([cableGroupRefKey({ kind: 'device', nodeId: 'chassis:gone' })]);
  });
});

describe('the old choice carried over — decision 1', () => {
  it('copper/fibre/power becomes that type group, ticked', () => {
    const rig = new Rig();
    const a = rig.addDevice(['Et1']);
    const b = rig.addDevice(['Et1']);
    rig.connect(a.portIds[0], b.portIds[0]);
    const view = viewFor(rig.doc);
    const migrated = cableGroupsStateFromOldVisibility('fibre', view);
    expect(migrated.none).toBe(false);
    const fibre = migrated.groups.find((g) => g.ref.kind === 'type' && g.ref.type === 'fibre');
    expect(fibre?.on).toBe(true);
  });

  it('none becomes None', () => {
    const view: ClosetView = viewFor(emptyDocument());
    const migrated = cableGroupsStateFromOldVisibility('none', view);
    expect(migrated.none).toBe(true);
    expect(migrated.groups.every((g) => !g.on)).toBe(true);
  });

  it('all becomes the plain default — no group ticked, None off', () => {
    const view: ClosetView = viewFor(emptyDocument());
    const migrated = cableGroupsStateFromOldVisibility('all', view);
    expect(migrated).toEqual(defaultCableGroupsState(view));
  });
});

describe('defaultCableGroupsState — "the types that occur in the view, all unticked"', () => {
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

describe('availableCableGroupRefs', () => {
  it('offers every type even with none present, plus VLANs/tags/devices that exist', () => {
    const rig = new Rig();
    const { deviceId } = rig.addDevice([]);
    rig.doc = addVlan(rig.doc, { vlanId: 10, on: [deviceId] }, { now: NOW });
    rig.doc = tagObject(rig.doc, deviceId, 'core', { now: NOW });
    const view = viewFor(rig.doc);
    const refs = availableCableGroupRefs(rig.doc, view);
    for (const t of CABLE_TYPE_GROUPS) expect(refs).toContainEqual({ kind: 'type', type: t });
    expect(refs.some((r) => r.kind === 'vlan')).toBe(true);
    expect(refs.some((r) => r.kind === 'tag' && r.fold === foldTagName('core'))).toBe(true);
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
});
