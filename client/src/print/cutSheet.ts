// The cut sheet — brief item 4: one block per device (a header row of name,
// model, placement, then one row per port, free ports included), grouped
// per equipment as the team's own Excel sheet already is. Every device in
// the closet gets a block: racked, on a shelf or a surface, or not placed.
import { deriveNetworks, type VlanRow } from '../document/networks-derive';
import type { Document } from '../document/model';
import type { CableView, ChassisView, ClosetView, FixtureView, PortView, RackView } from '../document/view';
import { unitRangeLabel } from './units';

const ABSENT = '—';

export interface CutSheetPortRow {
  port: string;
  connector: string;
  farEnd: string;
  cable: string;
  colour: string;
  vlans: string;
}

export interface CutSheetDevice {
  key: string;
  name: string;
  model: string;
  placement: string;
  rows: CutSheetPortRow[];
}

interface PortOwner {
  name: string;
}

/** Every port this closet carries, by id, paired with the name of whatever
 * owns it — built once so `farEnd` below is a lookup, never a second walk
 * of the whole closet per port. */
function buildLookup(view: ClosetView): { owners: Map<string, PortOwner>; ports: Map<string, PortView> } {
  const owners = new Map<string, PortOwner>();
  const ports = new Map<string, PortView>();

  function addPorts(ownerId: string, name: string, list: readonly PortView[]) {
    owners.set(ownerId, { name });
    for (const p of list) ports.set(p.id, p);
  }

  for (const rack of view.racks) {
    for (const c of rack.chassis) addPorts(c.id, c.hostname || ABSENT, [...c.ports, ...c.psuInlets]);
    for (const shelf of rack.shelves) {
      for (const occ of shelf.occupants) addPorts(occ.id, occ.label || ABSENT, occ.ports);
    }
  }
  function addFixtures(fixtures: readonly FixtureView[]) {
    for (const f of fixtures) {
      addPorts(f.id, f.label || ABSENT, [...f.ports, ...f.psuInlets]);
      addFixtures(f.fixtures);
    }
  }
  for (const surface of view.surfaces) addFixtures(surface.fixtures);
  for (const c of view.unplaced) addPorts(c.id, c.hostname || ABSENT, [...c.ports, ...c.psuInlets]);

  return { owners, ports };
}

function vlanCellFor(cableId: string | undefined, vlanRows: readonly VlanRow[]): string {
  if (cableId == null) return '';
  const hits: { vlanId: number; mode: 'access' | 'trunk' | undefined }[] = [];
  for (const row of vlanRows) {
    for (const member of row.members) {
      if (member.cableId === cableId) hits.push({ vlanId: row.vlanId, mode: member.mode });
    }
  }
  if (hits.length === 0) return '';
  const ids = [...new Set(hits.map((h) => h.vlanId))].sort((a, b) => a - b);
  const modes = new Set(hits.map((h) => h.mode).filter((m): m is 'access' | 'trunk' => m != null));
  const prefix = modes.size === 1 ? `${[...modes][0]} ` : '';
  return prefix + ids.join(' ');
}

function portRowsOf(
  ports: readonly PortView[],
  cablesById: Map<string, CableView>,
  ownerOf: Map<string, PortOwner>,
  portsById: Map<string, PortView>,
  vlanRows: readonly VlanRow[],
): CutSheetPortRow[] {
  return ports.map((port) => {
    const cable = port.cable;
    if (cable == null) {
      return { port: port.label, connector: port.connector, farEnd: `${ABSENT} free`, cable: '', colour: '', vlans: '' };
    }
    const cv = cablesById.get(cable.cableId);
    const farPort = cable.farPortId != null ? portsById.get(cable.farPortId) : undefined;
    const farOwner = cable.farChassisId != null ? ownerOf.get(cable.farChassisId) : undefined;
    let farEnd: string;
    if (farOwner && farPort) farEnd = `${farOwner.name} ${farPort.label}`;
    else if (cable.outsideCloset) farEnd = 'outside';
    else farEnd = ABSENT;
    return {
      port: port.label,
      connector: port.connector,
      farEnd,
      cable: cv?.label ?? '',
      colour: cv?.sheath ?? '',
      vlans: vlanCellFor(cv?.id, vlanRows),
    };
  });
}

function rackPlacementLabel(rack: Pick<RackView, 'label' | 'heightU' | 'unitNumbering'>, c: Pick<ChassisView, 'positionU' | 'heightU'>): string {
  return `Rack ${rack.label} · U${unitRangeLabel(rack.heightU, rack.unitNumbering, c.positionU, c.heightU)}`;
}

/**
 * Every device in `view`, one `CutSheetDevice` block each — racked devices
 * first (rack order, top to bottom within a rack), then shelf occupants,
 * then surface/board fixtures, then unplaced devices. `doc` is read once,
 * through `deriveNetworks` (cached per document), for each port's VLAN
 * membership.
 */
export function buildCutSheet(doc: Document, view: ClosetView): CutSheetDevice[] {
  const { owners, ports } = buildLookup(view);
  const { vlanRows } = deriveNetworks(doc);
  const cablesById = new Map(view.cables.map((c) => [c.id, c]));
  const devices: CutSheetDevice[] = [];

  const rowsFor = (list: readonly PortView[]) => portRowsOf(list, cablesById, owners, ports, vlanRows);

  for (const rack of view.racks) {
    const sorted = [...rack.chassis].sort((a, b) => b.positionU - a.positionU);
    for (const c of sorted) {
      devices.push({
        key: c.id,
        name: c.hostname || ABSENT,
        model: c.model || ABSENT,
        placement: rackPlacementLabel(rack, c),
        rows: rowsFor([...c.ports, ...c.psuInlets]),
      });
    }
    for (const shelf of rack.shelves) {
      for (const occ of [...shelf.occupants].sort((a, b) => a.slot - b.slot)) {
        devices.push({
          key: occ.id,
          name: occ.label || ABSENT,
          model: occ.model ?? ABSENT,
          placement: shelf.label || ABSENT,
          rows: rowsFor(occ.ports),
        });
      }
    }
  }

  function walkFixtures(fixtures: readonly FixtureView[], parentLabel: string) {
    for (const f of fixtures) {
      devices.push({
        key: f.id,
        name: f.label || ABSENT,
        model: f.model ?? ABSENT,
        placement: parentLabel,
        rows: rowsFor([...f.ports, ...f.psuInlets]),
      });
      walkFixtures(f.fixtures, f.label || parentLabel);
    }
  }
  for (const surface of view.surfaces) walkFixtures(surface.fixtures, surface.label || ABSENT);

  for (const c of view.unplaced) {
    devices.push({
      key: c.id,
      name: c.hostname || ABSENT,
      model: c.model || ABSENT,
      placement: 'not placed',
      rows: rowsFor([...c.ports, ...c.psuInlets]),
    });
  }

  return devices;
}
