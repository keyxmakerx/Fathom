import { describe, expect, it } from 'vitest';

import { ABSENT } from '../drawing/contract';
import type { CableView, ChassisView, InletView, Placement, PortView } from '../../document/view';
import { viewOf } from '../../document/view';
import {
  createRack,
  createSurface,
  createShelf,
  createSketchDevice,
  movePlacement,
} from '../../document/commands';
import { edgesIn, emptyDocument, formatNodeId, parseNodeId, type Document } from '../../document/model';
import { newUlid } from '../../document/ulid';
import {
  BASE_COLUMNS,
  cablesByKindText,
  columnsForLens,
  deviceRowFromChassis,
  firmwareLabel,
  formatLastChange,
  gapRows,
  groupDeviceRows,
  inletStatesText,
  lastChangeMs,
  occupantPowerLabel,
  ownerLabel,
  portsCabledOfTotal,
  powerLabel,
  whereText,
} from './rows';

const NOW = 1_726_000_000_000; // 2024-09-10T22:13:20.000Z

function port(id: string, overrides: Partial<PortView> = {}): PortView {
  return {
    id,
    label: id,
    connector: 'rj45',
    row: 0,
    column: 0,
    uplink: false,
    role: null,
    face: 'front',
    passThroughId: null,
    cable: null,
    ...overrides,
  };
}

function inlet(slot: string, overrides: Partial<InletView> = {}): InletView {
  return {
    ...port(`inlet-${slot}`, { connector: 'c14' }),
    slot,
    hotSwap: true,
    fitted: true,
    supplyId: null,
    serial: null,
    model: null,
    position: { row: 'single', column: 0 },
    ...overrides,
  };
}

describe('whereText', () => {
  it('reads a rack placement as rack and unit', () => {
    const p: Placement = { kind: 'rack', rackId: 'rack:x', positionU: 12, face: 'front' };
    expect(whereText(p, { rackLabel: 'A-04' })).toBe('A-04 · U12');
  });

  it('reads a shelf placement as shelf and slot', () => {
    const p: Placement = { kind: 'shelf', shelfId: 'passive-node:x', slot: 2 };
    expect(whereText(p, { shelfLabel: 'Shelf 1' })).toBe('Shelf 1 · slot 2');
  });

  it('reads a surface placement as surface and millimetres, when measured', () => {
    const p: Placement = { kind: 'surface', surfaceId: 'surface:x', xMm: 100, yMm: 200 };
    expect(whereText(p, { surfaceLabel: 'North wall' })).toBe('North wall · 100mm, 200mm');
  });

  it('reads an unmeasured surface placement as the surface and absent', () => {
    const p: Placement = { kind: 'surface', surfaceId: 'surface:x', xMm: null, yMm: null };
    expect(whereText(p, { surfaceLabel: 'North wall' })).toBe(`North wall · ${ABSENT}`);
  });

  it('reads a board placement the same way as a surface', () => {
    const p: Placement = { kind: 'board', boardId: 'passive-node:x', xMm: 10, yMm: 20 };
    expect(whereText(p, { surfaceLabel: 'Backboard' })).toBe('Backboard · 10mm, 20mm');
  });

  it('reads no placement as absent', () => {
    expect(whereText({ kind: 'none' })).toBe(ABSENT);
  });

  it('falls back to the raw id when no label is supplied — a real fact, just not the friendly name', () => {
    const p: Placement = { kind: 'rack', rackId: 'rack:abc', positionU: 1, face: 'front' };
    expect(whereText(p)).toBe('rack:abc · U1');
  });
});

describe('the last-change rule', () => {
  function docWithField(assertedAt: number): { doc: Document; nodeId: string } {
    const nodeId = formatNodeId('Device', newUlid(assertedAt));
    const provId = newUlid(assertedAt);
    const doc: Document = {
      ...emptyDocument(),
      provenance: [{ id: provId, origin: { kind: 'hand' }, assertedAt, assertedBy: 'user', confidence: 'asserted' }],
      nodes: [{ id: nodeId, existence: provId, fields: { 'Device.hostname': { presence: 'set', prov: provId, value: 'core-01' } } }],
    };
    return { doc, nodeId };
  }

  it('reads the one field it has', () => {
    const { doc, nodeId } = docWithField(1000);
    expect(lastChangeMs(doc, [nodeId])).toBe(1000);
  });

  it('is the newest assertedAt across every named node, not the first', () => {
    const older = docWithField(1000);
    const newerNodeId = formatNodeId('Chassis', newUlid(2000));
    const newerProv = newUlid(2000);
    const doc: Document = {
      ...older.doc,
      provenance: [...older.doc.provenance, { id: newerProv, origin: { kind: 'hand' }, assertedAt: 2000, assertedBy: 'user', confidence: 'asserted' }],
      nodes: [...older.doc.nodes, { id: newerNodeId, existence: newerProv, fields: { 'Chassis.serial': { presence: 'set', prov: newerProv, value: 'SN1' } } }],
    };
    expect(lastChangeMs(doc, [older.nodeId, newerNodeId])).toBe(2000);
  });

  it('is null when none of the named nodes carry a field', () => {
    const doc = emptyDocument();
    expect(lastChangeMs(doc, ['device:nope'])).toBeNull();
  });

  it('formats as DD Mon HH:MM, in UTC', () => {
    expect(formatLastChange(Date.UTC(2026, 8, 12, 9, 41))).toBe('12 Sep 09:41');
  });
});

describe('ports and power labels', () => {
  it('counts cabled of total, absent for no ports', () => {
    expect(portsCabledOfTotal([])).toBe(ABSENT);
    expect(portsCabledOfTotal([port('a'), port('b', { cable: { cableId: 'cable:1', farPortId: null, farChassisId: null, outsideCloset: true } })])).toBe(
      '1 / 2',
    );
  });

  it('reads fed when every fitted inlet is cabled', () => {
    const fed = { cableId: 'cable:1', farPortId: null, farChassisId: null, outsideCloset: true };
    const inlets = [inlet('PSU0', { cable: fed })];
    expect(powerLabel(inlets, false, false)).toBe('fed');
  });

  it('reads single-fed and one-fitted off the flags, absent with no inlets', () => {
    expect(powerLabel([], false, false)).toBe(ABSENT);
    expect(powerLabel([inlet('PSU0'), inlet('PSU1')], true, false)).toBe('single-fed');
    expect(powerLabel([inlet('PSU0'), inlet('PSU1')], false, true)).toBe('one fitted');
  });

  it('reads absent for a fitted, uncabled single inlet — the one state the four words do not cover', () => {
    expect(powerLabel([inlet('PSU0', { cable: null })], false, false)).toBe(ABSENT);
  });

  it('reads an occupant c14 port the same way, without a hot-swap "one fitted" state', () => {
    expect(occupantPowerLabel([])).toBe(ABSENT);
    const fed = { cableId: 'cable:1', farPortId: null, farChassisId: null, outsideCloset: true };
    expect(occupantPowerLabel([port('p1', { connector: 'c14', cable: fed })])).toBe('fed');
    expect(occupantPowerLabel([port('p1', { connector: 'c14', cable: fed }), port('p2', { connector: 'c14', cable: null })])).toBe('single-fed');
  });

  it('reads cable counts by kind, absent with none', () => {
    const cables: CableView[] = [
      { id: 'cable:1', kind: 'copper', media: 'cat6', sheath: null, label: null, lengthM: null, ownership: null, ends: [] },
      { id: 'cable:2', kind: 'fibre', media: 'smf', sheath: null, label: null, lengthM: null, ownership: null, ends: [] },
    ];
    const ports = [
      port('p1', { cable: { cableId: 'cable:1', farPortId: null, farChassisId: null, outsideCloset: true } }),
      port('p2', { cable: { cableId: 'cable:2', farPortId: null, farChassisId: null, outsideCloset: true } }),
      port('p3'),
    ];
    expect(cablesByKindText(ports, cables)).toBe('copper 1 · fibre 1');
    expect(cablesByKindText([port('p1')], cables)).toBe(ABSENT);
  });

  it('reads per-slot inlet states, absent with no slots', () => {
    expect(inletStatesText([])).toBe(ABSENT);
    const fed = { cableId: 'cable:1', farPortId: null, farChassisId: null, outsideCloset: true };
    expect(
      inletStatesText([inlet('PSU0', { cable: fed }), inlet('PSU1', { cable: null }), inlet('PSU2', { fitted: false, cable: null })]),
    ).toBe('PSU0: fed · PSU1: not fed · PSU2: not fitted');
  });

  it('owner is always absent — the schema has no such field (CLAUDE.md rule 3)', () => {
    expect(ownerLabel()).toBe(ABSENT);
  });

  it('firmware is always absent — no such document field either (it lives on the server, per ADR-0045)', () => {
    expect(firmwareLabel()).toBe(ABSENT);
  });
});

describe('columnsForLens', () => {
  it('shows the base columns for Links and Routing', () => {
    expect(columnsForLens('links')).toEqual(BASE_COLUMNS);
    expect(columnsForLens('routing')).toEqual(BASE_COLUMNS);
  });

  it('replaces ports with cable counts by kind under Cables', () => {
    const cols = columnsForLens('cables');
    expect(cols).toContain('cablesByKind');
    expect(cols).not.toContain('ports');
  });

  it('replaces power with the inlet states under Power', () => {
    const cols = columnsForLens('power');
    expect(cols).toContain('inletStates');
    expect(cols).not.toContain('power');
  });

  it('replaces power with the owner field under Owner', () => {
    const cols = columnsForLens('owner');
    expect(cols).toContain('owner');
    expect(cols).not.toContain('power');
  });

  it('never adds a column no lens set already has, beyond the one substitution', () => {
    for (const lens of ['cables', 'links', 'routing', 'power', 'owner'] as const) {
      expect(columnsForLens(lens).length).toBe(BASE_COLUMNS.length);
    }
  });
});

describe('deviceRowFromChassis — the row derivation', () => {
  it('reads every column off the view, absent where the graph has nothing', () => {
    const chassis: ChassisView = {
      id: 'chassis:1',
      deviceId: 'device:1',
      hostname: 'core-01',
      model: 'EX4300-48P',
      vendor: 'juniper',
      positionU: 38,
      heightU: 1,
      face: 'front',
      ports: [port('ge-0/0/0', { cable: { cableId: 'cable:1', farPortId: null, farChassisId: null, outsideCloset: true } }), port('ge-0/0/1')],
      role: null,
      managementAddress: null,
      serial: null,
      psuInlets: [],
      singleFed: false,
      oneFitted: false,
      placement: { kind: 'rack', rackId: 'rack:1', positionU: 38, face: 'front' },
      sketch: false,
    };
    const doc = emptyDocument();
    const row = deviceRowFromChassis(chassis, doc, 'A-04', []);
    expect(row.name).toBe('core-01');
    expect(row.model).toBe('EX4300-48P');
    expect(row.where).toBe('A-04 · U38');
    expect(row.ports).toBe('1 / 2');
    expect(row.firmware).toBe(ABSENT);
    expect(row.power).toBe(ABSENT);
    expect(row.owner).toBe(ABSENT);
    expect(row.selection).toEqual({ kind: 'chassis', id: 'chassis:1' });
  });

  it('draws an unnamed device as absent, never a placeholder word', () => {
    const chassis: ChassisView = {
      id: 'chassis:2',
      deviceId: 'device:2',
      hostname: '',
      model: '',
      vendor: '',
      positionU: 1,
      heightU: 1,
      face: 'front',
      ports: [],
      role: null,
      managementAddress: null,
      serial: null,
      psuInlets: [],
      singleFed: false,
      oneFitted: false,
      placement: { kind: 'none' },
      sketch: false,
    };
    const row = deviceRowFromChassis(chassis, emptyDocument(), 'A-04', []);
    expect(row.name).toBe(ABSENT);
    expect(row.model).toBe(ABSENT);
    expect(row.where).toBe(ABSENT);
  });
});

// ---------------------------------------------------------------------------
// Grouping order — built through the real commands, `viewOf` and
// `groupDeviceRows` together, the same path `InventoryPlace.tsx` runs.

function newIdsSince(before: Document, after: Document, kind: string): string[] {
  const beforeIds = new Set(before.nodes.map((n) => n.id));
  return after.nodes.filter((n) => !beforeIds.has(n.id) && parseNodeId(n.id).kind === kind).map((n) => n.id);
}

describe('groupDeviceRows — the grouping order', () => {
  it('groups per rack, then shelves, then surfaces, then unplaced', () => {
    const premisesId = formatNodeId('Premises', newUlid(NOW));
    let doc: Document = {
      ...emptyDocument(),
      nodes: [{ id: premisesId, existence: newUlid(NOW), fields: { 'Premises.label': { presence: 'set', prov: newUlid(NOW), value: 'HQ' } } }],
    };

    doc = createRack(doc, premisesId, { label: 'A-04', heightU: 42, unitNumbering: 'ascending', now: NOW });
    const rackId = doc.nodes.find((n) => n.id !== premisesId)!.id;

    // A device sat directly in the rack.
    let before = doc;
    doc = createSketchDevice(doc, { hostname: 'rack-device', now: NOW });
    const rackChassisId = newIdsSince(before, doc, 'Chassis')[0];
    doc = movePlacement(doc, rackChassisId, { kind: 'rack', rackId, positionU: 10, face: 'front' }, { now: NOW });

    // A shelf on the same rack, with one occupant.
    doc = createShelf(doc, rackId, { positionU: 20, label: 'Shelf 1', now: NOW });
    const shelfId = edgesIn(doc, rackId, 'MountedIn').map((e) => e.from).find((id) => parseNodeId(id).kind === 'PassiveNode')!;
    before = doc;
    doc = createSketchDevice(doc, { hostname: 'shelf-device', now: NOW });
    const shelfChassisId = newIdsSince(before, doc, 'Chassis')[0];
    doc = movePlacement(doc, shelfChassisId, { kind: 'shelf', shelfId, slot: 0 }, { now: NOW });

    // A surface, with one fixture.
    doc = createSurface(doc, premisesId, { label: 'North wall', form: 'wall', now: NOW });
    const surfaceId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Surface')!.id;
    before = doc;
    doc = createSketchDevice(doc, { hostname: 'wall-device', now: NOW });
    const surfaceChassisId = newIdsSince(before, doc, 'Chassis')[0];
    doc = movePlacement(doc, surfaceChassisId, { kind: 'surface', surfaceId, xMm: 100, yMm: 100 }, { now: NOW });

    // An unplaced device — created, never placed anywhere.
    doc = createSketchDevice(doc, { hostname: 'spare-device', now: NOW });

    const view = viewOf(doc, []);
    const groups = groupDeviceRows(view, doc);
    const names = groups.map((g) => g.rows.map((r) => r.name));

    expect(groups.length).toBe(4);
    expect(names[0]).toEqual(['rack-device']);
    expect(names[1]).toEqual(['shelf-device']);
    expect(names[2]).toEqual(['wall-device']);
    expect(groups[3].label).toBe('Unplaced');
    expect(names[3]).toEqual(['spare-device']);
  });
});

describe('gapRows', () => {
  it('lists every rack free run as its own row', () => {
    const view = {
      premisesId: 'premises:1',
      unplaced: [],
      cables: [],
      rows: [],
      surfaces: [],
      racks: [
        {
          id: 'rack:1',
          label: 'A-04',
          heightU: 42,
          unitNumbering: 'ascending',
          row: null,
          bay: null,
          freeRuns: [
            { fromU: 1, toU: 10 },
            { fromU: 20, toU: 20 },
          ],
          shelves: [],
          chassis: [],
        },
      ],
    };
    const gaps = gapRows(view);
    expect(gaps).toEqual([
      { rackId: 'rack:1', rackLabel: 'A-04', fromU: 1, toU: 10, sizeU: 10 },
      { rackId: 'rack:1', rackLabel: 'A-04', fromU: 20, toU: 20, sizeU: 1 },
    ]);
  });
});
