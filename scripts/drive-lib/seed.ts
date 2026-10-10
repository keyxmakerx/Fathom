// Scenes for the drawing drives, copied into client/src/ as drive-seed.ts only
// while a drive runs. Built with the real document commands, so each is a real Document.

import { parseCatalogueModel, type CatalogueModel } from './api/catalogue';
import { createPremises } from './components/racks/emptyDesign';
import { connectPorts, type Sheath } from './document/cables';
import {
  addSketchPort,
  createRack,
  createShelf,
  createSketchDevice,
  createSurface,
  fixTo,
  movePlacement,
  placeChassis,
  placeOnShelf,
  type CreateSurfaceOptions,
} from './document/commands';
import { setChassisField, setDeviceField } from './document/edit';
import { addNote, type NoteHow } from './document/notes';
import { emptyDocument, formatEdgeId, formatNodeId, parseNodeId, type Document, type NodeKind } from './document/model';
import { addSubnet, addVlan } from './document/networks';
import { setFieldValue, type FieldDefView } from './document/fields';
import { bulkEstate } from './components/inventory/bulkEstate';
import { tagObject } from './document/tags';
import { begin, createFreeBox, finish, setNodeField } from './document/freeform';
import { setFirmwareHold, setTarget } from './document/firmware';
import { newUlid } from './document/ulid';
import { naturalLabelCompare, viewOf } from './document/view';

export function catalogueFrom(cat: { models: Record<string, unknown> }): CatalogueModel[] {
  return Object.values(cat.models).map((m) =>
    parseCatalogueModel(new TextEncoder().encode(JSON.stringify(m))),
  );
}

/** The config-drawer drive's own starting point: nothing placed yet, so the
 * driven browser drags a sketch device onto the pending rack itself. */
export function seedEmptyDesign(): Document {
  return emptyDocument();
}

function firstRack(doc: Document, catalogue: CatalogueModel[]) {
  return viewOf(doc, catalogue).racks[0];
}

/** Placed by `rackId` directly, not `firstRack`'s own racks[0] — the many
 * multi-rack scenes below (`seedManyDevicesScene` past one rack's own
 * capacity, `seedCableGroupsScene`) need a device landing in a SPECIFIC
 * rack, not always the first one `viewOf` happens to return. */
function place(
  doc: Document,
  catalogue: CatalogueModel[],
  rackId: string,
  model: CatalogueModel,
  positionU: number,
  hostname: string,
  actor: string,
): Document {
  let working = placeChassis(doc, rackId, model, positionU, 'front', { actor });
  const rack = viewOf(working, catalogue).racks.find((r) => r.id === rackId)!;
  const chassis = rack.chassis.find((c) => c.positionU === positionU)!;
  working = setDeviceField(working, chassis.deviceId, 'hostname', hostname, { actor });
  return working;
}

/** The device's lowest-numbered front RJ45 port, so both cable ends always
 * pair. Port order in the view follows random ids, so "first" is not
 * stable. Searches every rack, not only `firstRack`'s racks[0] — the same
 * reason `place` above does. */
function frontRj45(doc: Document, catalogue: CatalogueModel[], hostname: string): { deviceId: string; portId: string } {
  const view = viewOf(doc, catalogue);
  for (const rack of view.racks) {
    const chassis = rack.chassis.find((c) => c.hostname === hostname);
    if (!chassis) continue;
    const ports = chassis.ports
      .filter((p) => p.face === 'front' && p.connector === 'rj45')
      .sort((x, y) => x.label.localeCompare(y.label, undefined, { numeric: true }));
    if (ports.length === 0) continue;
    return { deviceId: chassis.deviceId, portId: ports[0].id };
  }
  throw new Error(`${hostname} has no front rj45 port`);
}

function oneRack(catalogue: CatalogueModel[], actor: string, heightU = 42): { doc: Document; rackId: string; premisesId: string } {
  let doc = emptyDocument();
  const premises = createPremises(doc, { actor });
  doc = createRack(premises.doc, premises.premisesId, {
    label: 'A-04',
    heightU,
    unitNumbering: 'ascending',
    actor,
  });
  return { doc, rackId: firstRack(doc, catalogue).id, premisesId: premises.premisesId };
}

/** The newest node of `kind` in `after` that was not in `before` —
 * `createSurface`/`createSketchDevice` return only the `Document`, never the id they minted. */
function newestNode(before: Document, after: Document, kind: NodeKind): string {
  const beforeIds = new Set(before.nodes.map((n) => n.id));
  const found = after.nodes.find((n) => !beforeIds.has(n.id) && parseNodeId(n.id).kind === kind);
  if (!found) throw new Error(`no new ${kind} node appeared`);
  return found.id;
}

function newSurface(
  doc: Document,
  premisesId: string,
  opts: CreateSurfaceOptions,
): { doc: Document; surfaceId: string } {
  const working = createSurface(doc, premisesId, opts);
  return { doc: working, surfaceId: newestNode(doc, working, 'Surface') };
}

function newSketchDevice(doc: Document, hostname: string, actor: string): { doc: Document; chassisId: string } {
  const working = createSketchDevice(doc, { hostname, actor });
  return { doc: working, chassisId: newestNode(doc, working, 'Chassis') };
}

/** A `FixtureView` port by connector, off a surface fixture named `hostname`
 * — a fixture's ports live under `SurfaceView.fixtures`, not `RackView.chassis`. */
function surfacePort(
  doc: Document,
  catalogue: CatalogueModel[],
  hostname: string,
  connector: string,
  occurrence = 0,
): { deviceId: string; portId: string } {
  const view = viewOf(doc, catalogue);
  for (const surface of view.surfaces) {
    const fixture = surface.fixtures.find((f) => f.label === hostname);
    if (!fixture) continue;
    const ports = fixture.ports.filter((p) => p.connector === connector);
    const port = ports[occurrence];
    if (!port) throw new Error(`${hostname} has no ${connector} port at occurrence ${occurrence}`);
    return { deviceId: fixture.id, portId: port.id };
  }
  throw new Error(`no surface fixture named ${hostname}`);
}

/** A device Inventory's own "Unplaced" group lists: one hand-made sketch
 * device (`createSketchDevice`), never moved anywhere. */
export function seedUnplacedDevice(me: string): Document {
  const doc = emptyDocument();
  const premises = createPremises(doc, { actor: me });
  const { doc: withDevice } = newSketchDevice(premises.doc, 'sketch-01', me);
  return withDevice;
}

/** One rack, one device — the "note"/"typed" scenes' own starting point: a
 * chassis to select and an editor panel to add a note in. */
export function seedSingleDevice(catalogue: CatalogueModel[], me: string): Document {
  const { doc, rackId } = oneRack(catalogue, me);
  const model = catalogue.find((m) => m.model === 'SRX340');
  if (!model) throw new Error('the drive catalogue fixture has no juniper/SRX340');
  return place(doc, catalogue, rackId, model, 42, 'hq-fw-01', me);
}

/** Two devices and a cable, both by `me` — the "trail" scene's own starting
 * point: "connect ports" is the newest batch, undoable with no conflict. */
export function seedConnectedDevices(catalogue: CatalogueModel[], me: string): Document {
  const { doc, rackId } = oneRack(catalogue, me);
  const core = catalogue.find((m) => m.model === 'EX4300-48P');
  const acc = catalogue.find((m) => m.model === 'EX2300-48P');
  if (!core || !acc) throw new Error('the drive catalogue fixture has no juniper/EX4300-48P or EX2300-48P');
  let working = place(doc, catalogue, rackId, core, 40, 'core-01', me);
  working = place(working, catalogue, rackId, acc, 38, 'acc-01', me);
  const a = frontRj45(working, catalogue, 'core-01');
  const b = frontRj45(working, catalogue, 'acc-01');
  const sheath: Sheath = 'blue';
  return connectPorts(working, a.portId, b.portId, { sheath }, { actor: me });
}

/** `seedConnectedDevices`, plus a colleague's own batch landed after it: a
 * note added to one of the two ports the cable just connected. A port is
 * `Notable` (`document/notes.ts`), and it is one of the elements
 * `document/undo.ts`'s own `touchedElements` reads off the cable-connect
 * batch — so Ctrl+Z on "connect ports" conflicts, ADR-0053 §3: undo refuses
 * rather than overwrite a colleague's later touch on the same element. */
export function seedConflictingChange(catalogue: CatalogueModel[], me: string, colleague: string): Document {
  const doc = seedConnectedDevices(catalogue, me);
  const a = frontRj45(doc, catalogue, 'core-01');
  const how: NoteHow = 'typed';
  return addNote(doc, a.portId, { text: 'checked the cabling', how, actor: colleague });
}

/** ADR-0051 §1/§2's equipment that is never rack-mounted: one rack (`sw-01`)
 * plus desk/floor/wall surfaces, each `FixedTo` it, cabled fw-01→switch and ont-01→fw-01. */
export function seedFreestanding(catalogue: CatalogueModel[], me: string): Document {
  const { doc, rackId, premisesId } = oneRack(catalogue, me);
  const switchModel = catalogue.find((m) => m.model === 'USW-24-PoE');
  if (!switchModel) throw new Error('the drive catalogue fixture has no ubiquiti/USW-24-PoE');
  let working = place(doc, catalogue, rackId, switchModel, 42, 'sw-01', me);

  const desk = newSurface(working, premisesId, { label: 'Desk 1', form: 'desk', actor: me });
  working = desk.doc;
  const fw = newSketchDevice(working, 'fw-01', me);
  working = fw.doc;
  working = fixTo(working, fw.chassisId, desk.surfaceId, { xMm: 100, yMm: 50 }, { actor: me });
  for (let i = 0; i < 4; i += 1) {
    working = addSketchPort(
      working,
      fw.chassisId,
      { label: `eth${i}`, connector: 'rj45', service: 'ethernet', face: 'front' },
      { actor: me },
    );
  }
  working = addSketchPort(
    working,
    fw.chassisId,
    { label: 'power', connector: 'c14', service: 'power', face: 'rear' },
    { actor: me },
  );

  const floor = newSurface(working, premisesId, { label: 'Floor 1', form: 'floor', actor: me });
  working = floor.doc;
  const ups = newSketchDevice(working, 'ups-01', me);
  working = ups.doc;
  working = fixTo(working, ups.chassisId, floor.surfaceId, { xMm: 150 }, { actor: me });
  working = addSketchPort(
    working,
    ups.chassisId,
    { label: 'out1', connector: 'c13', service: 'power', face: 'rear' },
    { actor: me },
  );
  working = addSketchPort(
    working,
    ups.chassisId,
    { label: 'out2', connector: 'c13', service: 'power', face: 'rear' },
    { actor: me },
  );
  working = addSketchPort(
    working,
    ups.chassisId,
    { label: 'in', connector: 'c14', service: 'power', face: 'rear' },
    { actor: me },
  );

  const wall = newSurface(working, premisesId, { label: 'Wall 1', form: 'wall', actor: me });
  working = wall.doc;
  const ont = newSketchDevice(working, 'ont-01', me);
  working = ont.doc;
  working = fixTo(working, ont.chassisId, wall.surfaceId, { xMm: 200, yMm: 800 }, { actor: me });
  working = addSketchPort(
    working,
    ont.chassisId,
    { label: 'eth0', connector: 'rj45', service: 'ethernet', face: 'front' },
    { actor: me },
  );
  working = addSketchPort(
    working,
    ont.chassisId,
    { label: 'pon', connector: 'sc', service: 'pon', face: 'front' },
    { actor: me },
  );

  const switchPort = frontRj45(working, catalogue, 'sw-01');
  const fwToSwitch = surfacePort(working, catalogue, 'fw-01', 'rj45', 0);
  working = connectPorts(working, fwToSwitch.portId, switchPort.portId, { sheath: 'blue' as Sheath }, { actor: me });

  const ontPort = surfacePort(working, catalogue, 'ont-01', 'rj45', 0);
  const fwToOnt = surfacePort(working, catalogue, 'fw-01', 'rj45', 1);
  working = connectPorts(working, ontPort.portId, fwToOnt.portId, { sheath: 'yellow' as Sheath }, { actor: me });

  return working;
}

/** Five sketch devices and no rack: a and b cabled together, c and d not, e for the subnet.
 * The drive adds the networks itself through the Add network editor. */
export function seedNetworksScene(catalogue: CatalogueModel[], me: string): Document {
  void catalogue; // sketch devices need no catalogue model
  let doc = emptyDocument();

  function sketchDevice(hostname: string, portLabel: string): { deviceId: string; chassisId: string; portId: string } {
    const beforeDevice = doc;
    doc = createSketchDevice(doc, { hostname, actor: me });
    const deviceId = newestNode(beforeDevice, doc, 'Device');
    const chassisId = newestNode(beforeDevice, doc, 'Chassis');
    const beforePort = doc;
    doc = addSketchPort(doc, chassisId, { label: portLabel, connector: 'rj45', face: 'front' }, { actor: me });
    const portId = newestNode(beforePort, doc, 'PhysicalPort');
    return { deviceId, chassisId, portId };
  }

  const a = sketchDevice('sketch-a', 'Et1');
  const b = sketchDevice('sketch-b', 'Et1');
  const sheath: Sheath = 'blue';
  doc = connectPorts(doc, a.portId, b.portId, { sheath }, { actor: me });

  sketchDevice('sketch-c', 'Et1');
  sketchDevice('sketch-d', 'Et1');

  sketchDevice('sketch-e', 'wg0');

  return doc;
}

/** One sketch device, no rack, no port — a Docker bridge network needs
 * neither. The drive adds the network, containers and ports itself. */
export function seedDockerScene(catalogue: CatalogueModel[], me: string): Document {
  void catalogue;
  const doc = createSketchDevice(emptyDocument(), { hostname: 'dock-01', actor: me });
  return doc;
}

/** A 42U rack fully populated with 42 devices, plus five smaller mixed
 * racks — sketch devices with one port each, not a heavy catalogue faceplate repeated 42 times. */
export function seedPrintScene(catalogue: CatalogueModel[], me: string): Document {
  let doc = emptyDocument();
  const premises = createPremises(doc, { actor: me });
  doc = premises.doc;
  const premisesId = premises.premisesId;

  const varietyNames = ['SRX340', 'USW-24-PoE', 'UDM-SE'];
  const variety = varietyNames.map((name) => catalogue.find((m) => m.model === name));
  if (variety.some((m) => !m)) {
    throw new Error('the drive catalogue fixture is missing a model seedPrintScene needs');
  }

  function mkRack(label: string, heightU: number): string {
    const before = doc;
    doc = createRack(doc, premisesId, { label, heightU, unitNumbering: 'ascending', actor: me });
    return newestNode(before, doc, 'Rack');
  }

  function place(rackId: string, model: CatalogueModel, positionU: number, hostname: string): void {
    const before = doc;
    doc = placeChassis(doc, rackId, model, positionU, 'front', { actor: me });
    const deviceId = newestNode(before, doc, 'Device');
    doc = setDeviceField(doc, deviceId, 'hostname', hostname, { actor: me });
  }

  /** One RJ45 port, nothing else — light enough that 42 of these render in
   * a real browser without the page looking hung. */
  function placeSketch(rackId: string, positionU: number, hostname: string): void {
    const before = doc;
    doc = createSketchDevice(doc, { hostname, actor: me });
    const chassisId = newestNode(before, doc, 'Chassis');
    doc = addSketchPort(doc, chassisId, { label: 'eth0', connector: 'rj45', service: 'ethernet', face: 'front' }, { actor: me });
    doc = movePlacement(doc, chassisId, { kind: 'rack', rackId, positionU, face: 'front' }, { actor: me });
  }

  // Rack 1 — 42U, fully populated, so its own rack sheet needs exactly two
  // pages on A4 and on Letter.
  const rack1 = mkRack('R1', 42);
  const rack1Hostnames: string[] = [];
  for (let u = 1; u <= 42; u += 1) {
    const hostname = `sw-${String(u).padStart(2, '0')}`;
    placeSketch(rack1, u, hostname);
    rack1Hostnames.push(hostname);
  }

  // Racks 2-6 — a smaller, mixed closet, two catalogue devices each (real
  // faceplates, real free ports, for the cut sheet's own variety).
  const otherPairs: [string, string][] = [];
  let rack2Id = '';
  for (let r = 2; r <= 6; r += 1) {
    const rackId = mkRack(`R${r}`, 12);
    if (r === 2) rack2Id = rackId;
    const model = variety[(r - 2) % variety.length]!;
    const a = `r${r}-a`;
    const b = `r${r}-b`;
    place(rackId, model, 10, a);
    place(rackId, model, 8, b);
    otherPairs.push([a, b]);
  }

  // A shelf on R2, with two occupants — the rack sheet's own coverage of
  // ADR-0051's shelves, drawn at their unit and listed in the table.
  const beforeShelf = doc;
  doc = createShelf(doc, rack2Id, { positionU: 3, label: 'patch shelf', actor: me });
  const shelfId = newestNode(beforeShelf, doc, 'PassiveNode');
  for (const occupantHostname of ['nuc-01', 'ont-01']) {
    const beforeOcc = doc;
    doc = createSketchDevice(doc, { hostname: occupantHostname, actor: me });
    const occChassisId = newestNode(beforeOcc, doc, 'Chassis');
    const slot = occupantHostname === 'nuc-01' ? 0 : 1;
    doc = movePlacement(doc, occChassisId, { kind: 'shelf', shelfId, slot }, { actor: me });
  }

  // One `viewOf` call for the whole scene — every port id below is a
  // lookup against it, never a fresh traversal.
  const view = viewOf(doc, catalogue);
  const byHostname = new Map(view.racks.flatMap((r) => r.chassis).map((c) => [c.hostname, c] as const));

  function firstFrontRj45(hostname: string): string {
    const chassis = byHostname.get(hostname);
    if (!chassis) throw new Error(`no chassis named ${hostname}`);
    const ports = chassis.ports
      .filter((p) => p.face === 'front' && p.connector === 'rj45')
      .sort((a, b) => naturalLabelCompare(a.label, b.label));
    if (ports.length === 0) throw new Error(`${hostname} has no front rj45 port`);
    return ports[0].id;
  }

  const sheaths: Sheath[] = ['blue', 'grey', 'yellow', 'green', 'red'];
  let sheathIndex = 0;
  function connect(hostA: string, hostB: string): void {
    const a = firstFrontRj45(hostA);
    const b = firstFrontRj45(hostB);
    const sheath = sheaths[sheathIndex % sheaths.length];
    sheathIndex += 1;
    doc = connectPorts(doc, a, b, { sheath }, { actor: me });
  }

  for (let i = 0; i + 1 < rack1Hostnames.length; i += 2) {
    connect(rack1Hostnames[i], rack1Hostnames[i + 1]);
  }
  for (const [a, b] of otherPairs) connect(a, b);

  return doc;
}

/** A layout-stress scene: 50-character FQDN hostnames, a long cable label
 * and many VLANs — real values long enough to overflow a fixed-height row. */
export function seedPrintAttackScene(catalogue: CatalogueModel[], me: string): Document {
  let doc = emptyDocument();
  const premises = createPremises(doc, { actor: me });
  doc = premises.doc;
  const premisesId = premises.premisesId;

  const before1 = doc;
  doc = createRack(doc, premisesId, { label: 'R1', heightU: 38, unitNumbering: 'ascending', actor: me });
  const rackId = newestNode(before1, doc, 'Rack');

  const hostnames: string[] = [];
  for (let u = 1; u <= 38; u += 1) {
    const hostname = `access-switch-${String(u).padStart(2, '0')}.floor-3.building-a.example-corp.net`;
    const before = doc;
    doc = createSketchDevice(doc, { hostname, actor: me });
    const chassisId = newestNode(before, doc, 'Chassis');
    for (let p = 0; p < 12; p += 1) {
      doc = addSketchPort(doc, chassisId, { label: `eth${p}`, connector: 'rj45', service: 'ethernet', face: 'front' }, { actor: me });
    }
    doc = movePlacement(doc, chassisId, { kind: 'rack', rackId, positionU: u, face: 'front' }, { actor: me });
    hostnames.push(hostname);
  }

  const view = viewOf(doc, catalogue);
  const byHostname = new Map(view.racks.flatMap((r) => r.chassis).map((c) => [c.hostname, c] as const));
  function portId(hostname: string, label: string): string {
    const c = byHostname.get(hostname)!;
    return c.ports.find((p) => p.label === label)!.id;
  }

  const longCableLabel = 'PATCH-DC1-RACK04-U22-TO-RACK04-U18-PRIMARY-UPLINK-REDUNDANT-001';
  for (let i = 0; i + 1 < hostnames.length; i += 2) {
    const label = i === 0 ? longCableLabel : `C-${String(i).padStart(3, '0')}`;
    doc = connectPorts(doc, portId(hostnames[i], 'eth0'), portId(hostnames[i + 1], 'eth0'), { sheath: 'blue', label }, { actor: me });
  }

  // Many VLANs, spread across several cabled ports on the first device —
  // a fresh unit refuses a tagged (trunk) attach, so access mode per port instead.
  const firstDevice = byHostname.get(hostnames[0])!;
  for (let i = 0; i < 8; i += 1) {
    doc = addSketchPort(doc, firstDevice.id, { label: `vlan-${i}`, connector: 'rj45', service: 'ethernet', face: 'front' }, { actor: me });
  }
  const withVlanPorts = viewOf(doc, catalogue);
  const firstDeviceView = withVlanPorts.racks.flatMap((r) => r.chassis).find((c) => c.hostname === hostnames[0])!;
  function vlanPort(i: number): string {
    return firstDeviceView.ports.find((p) => p.label === `vlan-${i}`)!.id;
  }
  const vlanIds = [110, 120, 130, 140, 150, 160, 170, 180];
  for (let i = 0; i + 1 < 8; i += 2) {
    doc = connectPorts(doc, vlanPort(i), vlanPort(i + 1), { sheath: 'yellow' }, { actor: me });
    doc = addVlan(doc, { vlanId: vlanIds[i], name: `many-vlans-${vlanIds[i]}`, attach: [{ target: { kind: 'port', portId: vlanPort(i), interfaceName: `vlan-${i}` } }] }, { actor: me });
  }

  return doc;
}

/** A real, mixed-vendor rack for the owner's own look against the board's
 * print panel: a patch panel, a switch, a firewall, two servers, a NAS, a UPS and a PDU, every model real, with a serial and a management address. */
export function seedPrintLoftScene(catalogue: CatalogueModel[], me: string): Document {
  let doc = emptyDocument();
  const premises = createPremises(doc, { actor: me });
  doc = premises.doc;
  const premisesId = premises.premisesId;

  const before1 = doc;
  doc = createRack(doc, premisesId, { label: 'R1', heightU: 24, unitNumbering: 'ascending', actor: me });
  const rackId = newestNode(before1, doc, 'Rack');

  function modelOf(vendor: string, model: string): CatalogueModel {
    const found = catalogue.find((m) => m.vendor === vendor && m.model === model);
    if (!found) throw new Error(`the drive catalogue fixture is missing ${vendor}/${model}`);
    return found;
  }

  function place(positionU: number, vendor: string, model: string, hostname: string): { deviceId: string; chassisId: string } {
    const before = doc;
    doc = placeChassis(doc, rackId, modelOf(vendor, model), positionU, 'front', { actor: me });
    const deviceId = newestNode(before, doc, 'Device');
    const chassisId = newestNode(before, doc, 'Chassis');
    doc = setDeviceField(doc, deviceId, 'hostname', hostname, { actor: me });
    return { deviceId, chassisId };
  }

  place(24, 'panduit', 'NK6PPG24Y', 'patch-01');
  const sw = place(22, 'ubiquiti', 'USW-24-PoE', 'sw-core');
  const fw = place(21, 'juniper', 'SRX300', 'fw-01');
  const dock1 = place(17, 'dell', 'R740xd', 'dock-01');
  const dock2 = place(15, 'hpe', 'DL380-Gen10', 'dock-02');
  const nas = place(14, 'synology', 'RS822+', 'nas-01');
  const ups = place(2, 'cyberpower', 'PR1500LCDRT2U', 'ups-01');
  const pdu = place(1, 'apc', 'AP7920B', 'pdu-01');

  // Every device but the patch panel gets a serial and a management
  // address, so "leave out serials" has something real to hide.
  const fitted: [{ deviceId: string; chassisId: string }, string, string][] = [
    [sw, 'CTAZ2609J001', '10.20.0.2'],
    [fw, 'AK0625AB0042', '10.20.0.1'],
    [dock1, 'FCH2609AB01', '10.20.0.11'],
    [dock2, 'MXQ2609XY02', '10.20.0.12'],
    [nas, '2050LOFT0001', '10.20.0.20'],
    [ups, '3B2609PR0099', '10.20.0.30'],
    [pdu, '5A2609AP0007', '10.20.0.31'],
  ];
  for (const [target, serial, mgmt] of fitted) {
    doc = setChassisField(doc, target.chassisId, 'serial', serial, { actor: me });
    doc = setDeviceField(doc, target.deviceId, 'management_address', mgmt, { actor: me });
  }

  const view = viewOf(doc, catalogue);
  const byHostname = new Map(view.racks.flatMap((r) => r.chassis).map((c) => [c.hostname, c] as const));
  function onePort(hostname: string, face: 'front' | 'rear', connector: string, occurrence: number): string {
    const c = byHostname.get(hostname)!;
    const ports = c.ports.filter((p) => p.face === face && p.connector === connector).sort((a, b) => a.column - b.column);
    if (!ports[occurrence]) throw new Error(`${hostname} has no ${face} ${connector} port #${occurrence}`);
    return ports[occurrence].id;
  }

  doc = connectPorts(doc, onePort('patch-01', 'front', 'rj45', 0), onePort('sw-core', 'front', 'rj45', 0), { sheath: 'blue' }, { actor: me });
  doc = connectPorts(doc, onePort('sw-core', 'front', 'sfp_plus', 0), onePort('fw-01', 'front', 'sfp_plus', 0), { sheath: 'yellow', label: 'uplink, trunk' }, { actor: me });
  doc = connectPorts(doc, onePort('dock-01', 'rear', 'rj45', 0), onePort('sw-core', 'front', 'rj45', 1), { sheath: 'blue' }, { actor: me });
  doc = connectPorts(doc, onePort('dock-02', 'rear', 'rj45', 0), onePort('sw-core', 'front', 'rj45', 2), { sheath: 'blue' }, { actor: me });
  doc = connectPorts(doc, onePort('nas-01', 'rear', 'rj45', 0), onePort('sw-core', 'front', 'rj45', 3), { sheath: 'blue' }, { actor: me });

  return doc;
}

/** Enough rack-mounted devices, side by side, that a hover, a selection, a
 * drag or a wheel-zoom touches many nodes nobody meant to disturb. One cable between the first two, so a hover has something lit to prove stays lit. */
/** `Rack.height_u`'s own schema bound (`schema/schema.yaml`: `range: 1..100`)
 * — one rack alone cannot hold a count past 100, so past 42 (the reference
 * height every other scene in this file uses) this spills into further
 * racks, same label scheme (`A-04`, `A-05`, ...), `dev-NN` numbering
 * carrying straight across the seam. */
const MANY_DEVICES_RACK_HEIGHT_U = 42;

export function seedManyDevicesScene(catalogue: CatalogueModel[], me: string, count = 16): Document {
  const model = catalogue.find((m) => m.model === 'EX4300-48P');
  if (!model) throw new Error('the drive catalogue fixture has no juniper/EX4300-48P');
  let doc = emptyDocument();
  const premises = createPremises(doc, { actor: me });
  doc = premises.doc;
  const rackCount = Math.max(1, Math.ceil(count / MANY_DEVICES_RACK_HEIGHT_U));
  const rackIds: string[] = [];
  for (let r = 0; r < rackCount; r += 1) {
    const before = doc;
    doc = createRack(doc, premises.premisesId, {
      label: `A-${String(4 + r).padStart(2, '0')}`,
      heightU: MANY_DEVICES_RACK_HEIGHT_U,
      unitNumbering: 'ascending',
      actor: me,
    });
    rackIds.push(newestNode(before, doc, 'Rack'));
  }
  let working = doc;
  for (let i = 0; i < count; i += 1) {
    const rackId = rackIds[Math.floor(i / MANY_DEVICES_RACK_HEIGHT_U)];
    const positionU = (i % MANY_DEVICES_RACK_HEIGHT_U) + 1;
    working = place(working, catalogue, rackId, model, positionU, `dev-${String(i + 1).padStart(2, '0')}`, me);
  }
  const a = frontRj45(working, catalogue, 'dev-01');
  const b = frontRj45(working, catalogue, 'dev-02');
  return connectPorts(working, a.portId, b.portId, { sheath: 'blue' as Sheath }, { actor: me });
}

/** ADR-0059's own drive: `seedConnectedDevices`'s two devices and cable, with
 * `core-01` already carrying one tag ("core") so the suggestion list has
 * something to offer when the cable is tagged next. */
export function seedTagsScene(catalogue: CatalogueModel[], me: string): Document {
  const doc = seedConnectedDevices(catalogue, me);
  const core = firstRack(doc, catalogue).chassis.find((c) => c.hostname === 'core-01')!;
  return tagObject(doc, core.deviceId, 'core', { actor: me });
}

/** One rack holding a shelf at U20, with the sketch device `box-01` on its first slot. */
export function seedShelfScene(catalogue: CatalogueModel[], me: string): Document {
  const { doc, rackId } = oneRack(catalogue, me);
  const withShelf = createShelf(doc, rackId, { positionU: 20, label: 'Shelf 1', actor: me });
  const shelfId = newestNode(doc, withShelf, 'PassiveNode');
  const box = newSketchDevice(withShelf, 'box-01', me);
  let working = placeOnShelf(box.doc, box.chassisId, shelfId, 1, { actor: me });
  working = addSketchPort(working, box.chassisId, { label: 'eth0', connector: 'rj45', service: 'ethernet', face: 'front' }, { actor: me });
  return working;
}

/** Three catalogued devices in one rack, a bundle of three cables between the
 * two switches, an SFP+ link and one to the firewall: the canvas-looks-right scene. */
export function seedCanvasScene(catalogue: CatalogueModel[], me: string): Document {
  const { doc, rackId } = oneRack(catalogue, me, 12);
  const find = (model: string) => {
    const m = catalogue.find((c) => c.model === model);
    if (!m) throw new Error(`the drive catalogue fixture has no ${model}`);
    return m;
  };
  let working = place(doc, catalogue, rackId, find('SRX340'), 3, 'fw-01', me);
  working = place(working, catalogue, rackId, find('USW-48-PoE'), 6, 'core-sw-01', me);
  working = place(working, catalogue, rackId, find('USW-24-PoE'), 8, 'sw-02', me);
  const portsOf = (host: string, connector: string) =>
    firstRack(working, catalogue)
      .chassis.find((c) => c.hostname === host)!
      .ports.filter((p) => p.face === 'front' && p.connector.toLowerCase() === connector)
      .sort((x, y) => naturalLabelCompare(x.label, y.label));
  const link = (a: string, b: string, sheath: Sheath) => {
    working = connectPorts(working, a, b, { sheath }, { actor: me });
  };
  const coreRj = portsOf('core-sw-01', 'rj45');
  const accRj = portsOf('sw-02', 'rj45');
  for (let i = 0; i < 3; i += 1) link(coreRj[i]!.id, accRj[i]!.id, 'blue');
  link(portsOf('core-sw-01', 'sfp_plus')[0]!.id, portsOf('sw-02', 'sfp_plus')[0]!.id, 'yellow');
  link(coreRj[10]!.id, portsOf('fw-01', 'rj45')[0]!.id, 'green');
  return working;
}

/** The organisation field the inventory drive starts with (the harness serves it from its mocked store). */
export const COST_CENTRE: FieldDefView = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FCC',
  appliesTo: 'device',
  name: 'Cost centre',
  type: 'text',
  choices: [],
  version: 1,
  createdBy: 'drive',
  archived: false,
};

/** ADR-0062's drive: the tags scene, a "Cost centre" field with a value on core-01, and `count`
 * unplaced sketch devices so the table has hundreds of rows to window. */
export function seedInventoryScene(catalogue: CatalogueModel[], me: string, count = 600): Document {
  let doc = seedTagsScene(catalogue, me);
  const core = firstRack(doc, catalogue).chassis.find((c) => c.hostname === 'core-01')!;
  doc = setFieldValue(doc, core.deviceId, COST_CENTRE.id, 'IT-204', [COST_CENTRE], { actor: me });
  for (let i = 0; i < count; i += 1) {
    doc = createSketchDevice(doc, { hostname: `bulk-${String(i + 1).padStart(4, '0')}`, actor: me });
  }
  return doc;
}

/**
 * The prefixes drive: four sketch devices on one floor of one premises. fw-01 gateways VLAN 20
 * (10.0.20.0/24) and has 10.0.10.1/24 and 172.16.9.9/16; two nas/cam boxes sit in 10.0.20.0/24,
 * and nas-02 and cam-07 carry the same 10.0.20.16 so the page shows a clash.
 */
export function seedIpamScene(catalogue: CatalogueModel[], me: string): Document {
  void catalogue; // sketch devices need no catalogue model
  const premises = createPremises(emptyDocument(), { actor: me });
  const floor = newSurface(premises.doc, premises.premisesId, { label: 'Floor 1', form: 'floor', actor: me });
  let doc = floor.doc;
  const box = (hostname: string, ports: string[], role?: string) => {
    const made = newSketchDevice(doc, hostname, me);
    doc = fixTo(made.doc, made.chassisId, floor.surfaceId, { xMm: 100 + doc.nodes.length, yMm: 100 }, { actor: me });
    if (role) {
      const deviceId = doc.nodes.filter((n) => parseNodeId(n.id).kind === 'Device').find((n) => n.fields['Device.hostname']?.value === hostname)!.id;
      doc = setDeviceField(doc, deviceId, 'role', role, { actor: me });
    }
    return ports.map((label) => {
      const before = doc;
      doc = addSketchPort(doc, made.chassisId, { label, connector: 'rj45', face: 'front' }, { actor: me });
      return newestNode(before, doc, 'PhysicalPort');
    });
  };
  const fw = box('fw-01', ['ge-0/0/1', 'ge-0/0/2', 'ge-0/0/3'], 'firewall');
  const nas1 = box('nas-01', ['eth0']);
  const nas2 = box('nas-02', ['eth0']);
  const cam = box('cam-07', ['eth0']);
  const label = ['ge-0/0/1', 'ge-0/0/2', 'ge-0/0/3'];
  doc = addVlan(
    doc,
    { vlanId: 20, name: 'Storage', attach: [{ target: { kind: 'port', portId: fw[0]!, interfaceName: label[0]! }, gateway: true }], subnet: '10.0.20.0/24', gatewayAddress: '10.0.20.1/24' },
    { actor: me },
  );
  const put = (prefix: string, address: string, portId: string, name: string) => {
    doc = addSubnet(doc, { prefix, attach: [{ target: { kind: 'port', portId, interfaceName: name }, address }] }, { actor: me });
  };
  put('10.0.20.0/24', '10.0.20.15/24', nas1[0]!, 'eth0');
  put('10.0.20.0/24', '10.0.20.16/24', nas2[0]!, 'eth0');
  put('10.0.20.0/24', '10.0.20.16/24', cam[0]!, 'eth0');
  put('10.0.10.0/24', '10.0.10.1/24', fw[1]!, label[1]!);
  put('172.16.0.0/16', '172.16.9.9/16', fw[2]!, label[2]!);
  return doc;
}

/** The canvas scene plus three more racks and a firewall cable to sw-09 in the
 * last (R7), far enough away to draw as stubs: the look-switch scene. */
export function seedLookScene(catalogue: CatalogueModel[], me: string): Document {
  let working = seedCanvasScene(catalogue, me);
  const premisesId = viewOf(working, catalogue).premisesId;
  for (const label of ['R2', 'R3', 'R7']) {
    working = createRack(working, premisesId, { label, heightU: 12, unitNumbering: 'ascending', actor: me });
  }
  const rack = (label: string) => viewOf(working, catalogue).racks.find((r) => r.label === label)!;
  const srx = catalogue.find((c) => c.model === 'SRX340')!;
  working = placeChassis(working, rack('R7').id, srx, 3, 'front', { actor: me });
  const far = rack('R7').chassis[0]!;
  working = setDeviceField(working, far.deviceId, 'hostname', 'sw-09', { actor: me });
  const rj = (host: string, rackLabel: string) =>
    rack(rackLabel)
      .chassis.find((c) => c.hostname === host)!
      .ports.filter((p) => p.face === 'front' && p.connector.toLowerCase() === 'rj45')
      .sort((x, y) => naturalLabelCompare(x.label, y.label));
  working = connectPorts(working, rj('fw-01', 'A-04')[1]!.id, rj('sw-09', 'R7')[0]!.id, { sheath: 'red' }, { actor: me });
  return working;
}

/** Inventory v5's drives: a made-up estate (components/inventory/bulkEstate.ts). `scale` 1 is about
 * 1,900 devices, 13,000 ports and 5,000 cables. */
export function seedBulkEstate(me: string, scale: number): Document {
  return bulkEstate({ scale, actor: me }).doc;
}

/** The lowest-numbered UNCABLED front RJ45 port — `frontRj45`'s own doc,
 * plus "free": a device with several cables (`seedCableGroupsScene`'s own
 * `sw-core`) needs a fresh port picked each time, never the same one an
 * earlier call already terminated. */
function freeFrontRj45(doc: Document, catalogue: CatalogueModel[], hostname: string): { deviceId: string; portId: string; label: string } {
  const view = viewOf(doc, catalogue);
  for (const rack of view.racks) {
    const chassis = rack.chassis.find((c) => c.hostname === hostname);
    if (!chassis) continue;
    const ports = chassis.ports
      .filter((p) => p.face === 'front' && p.connector === 'rj45' && p.cable == null)
      .sort((x, y) => x.label.localeCompare(y.label, undefined, { numeric: true }));
    if (ports.length === 0) continue;
    return { deviceId: chassis.deviceId, portId: ports[0].id, label: ports[0].label };
  }
  throw new Error(`${hostname} has no free front rj45 port`);
}

/** The Cables list's own drive: one rack, `sw-core` and `sw-edge` (a trunk
 * uplink between them carrying VLAN 30 tagged), `cam-01` (VLAN 30, access),
 * `srv-01` (VLAN 10, access), a fibre pair (`nas-01` / `patch-01`, LC-LC,
 * media smf), a power lead (`ups-01` / `pdu-01`, C13-C14) and `wifi-ap`, sat
 * on its own shelf rather than mounted directly, tagged `shelfgear` — a
 * Device-kind tag proving it catches a shelf occupant's cable the same way
 * it catches a rack-mounted one's. Six cables: the trunk, the two access
 * leads, the fibre pair, the power lead and the shelf device's own uplink.
 *
 * The trunk cannot be built through `document/networks.ts`'s own
 * `attachToVlan` — "tagged... is refused unless the resolved unit already
 * carries a live trunk membership... a trunk is never made here" (its own
 * doc): a real trunk enters a document only through config the Rust engine
 * parses, which this seed script does not run. `LogicalUnit.vlan_id` alone
 * marks a unit a trunk carrier (`document/networks-derive.ts`'s own
 * `unitCarries`) — the same raw node/edge shape
 * `client/src/document/networks-derive.test.ts`'s own "pasted interface"
 * fixture and `client/src/components/drawing/cableGroups.test.ts`'s own
 * `trunkVlanScene` both build, reused here rather than invented twice. */
export function seedCableGroupsScene(catalogue: CatalogueModel[], me: string): Document {
  const { doc, rackId } = oneRack(catalogue, me);
  const coreModel = catalogue.find((m) => m.model === 'EX4300-48P');
  const edgeModel = catalogue.find((m) => m.model === 'EX2300-48P');
  if (!coreModel || !edgeModel) throw new Error('the drive catalogue fixture has no juniper/EX4300-48P or EX2300-48P');
  let working = place(doc, catalogue, rackId, coreModel, 40, 'sw-core', me);
  working = place(working, catalogue, rackId, edgeModel, 38, 'sw-edge', me);

  function sketch(hostname: string, positionU: number, portLabel: string, connector: string, service: string) {
    const beforeDevice = working;
    working = createSketchDevice(working, { hostname, actor: me });
    const chassisId = newestNode(beforeDevice, working, 'Chassis');
    const deviceId = newestNode(beforeDevice, working, 'Device');
    working = movePlacement(working, chassisId, { kind: 'rack', rackId, positionU, face: 'front' }, { actor: me });
    const beforePort = working;
    working = addSketchPort(working, chassisId, { label: portLabel, connector, service, face: 'front' }, { actor: me });
    const portId = newestNode(beforePort, working, 'PhysicalPort');
    return { chassisId, deviceId, portId };
  }

  const cam = sketch('cam-01', 10, 'Et0', 'rj45', 'ethernet');
  const srv = sketch('srv-01', 9, 'Et0', 'rj45', 'ethernet');
  const nas = sketch('nas-01', 8, 'p1', 'lc', 'ethernet');
  const patch = sketch('patch-01', 7, 'p1', 'lc', 'ethernet');
  const ups = sketch('ups-01', 6, 'out1', 'c13', 'power');
  const pdu = sketch('pdu-01', 5, 'in', 'c14', 'power');

  const trunkFar = freeFrontRj45(working, catalogue, 'sw-edge');
  const trunkNear = freeFrontRj45(working, catalogue, 'sw-core');
  working = connectPorts(working, trunkNear.portId, trunkFar.portId, { sheath: 'grey' as Sheath }, { actor: me });

  const camNear = freeFrontRj45(working, catalogue, 'sw-core');
  working = connectPorts(working, camNear.portId, cam.portId, { sheath: 'yellow' as Sheath }, { actor: me });

  // `srv-01` hangs off `sw-edge`, not `sw-core` — VLAN 10 needs no bridging
  // at all (one cable, its own domain already); VLAN 30's own bridging,
  // below, is `sw-core`'s alone, between exactly the two ports (`cam-01`'s
  // downlink and the trunk uplink) that VLAN 30 itself touches. Sharing a
  // bridged device with a THIRD, unrelated VLAN would merge that VLAN's own
  // domain into 30's too (`document/networks-derive.ts`'s "blank bridge"
  // unions every one of a device's own ports, not only the ones a VLAN
  // names) — true of a real dumb switch, wrong for this scene's own count.
  const srvNear = freeFrontRj45(working, catalogue, 'sw-edge');
  working = connectPorts(working, srvNear.portId, srv.portId, { sheath: 'blue' as Sheath }, { actor: me });

  working = connectPorts(working, nas.portId, patch.portId, { media: 'smf' }, { actor: me });
  working = connectPorts(working, ups.portId, pdu.portId, {}, { actor: me });

  // `wifi-ap`, sat on its own shelf rather than mounted directly — a
  // Device-kind tag placed on it (below) must catch its cable the same way
  // it catches a rack-mounted device's, `document/view.ts`'s own
  // `ShelfView.occupants` reached through `SitsOn`, never `MountedIn`.
  const beforeShelf = working;
  working = createShelf(working, rackId, { positionU: 4, label: 'AP shelf', actor: me });
  const shelfId = newestNode(beforeShelf, working, 'PassiveNode');
  const beforeShelfDevice = working;
  working = createSketchDevice(working, { hostname: 'wifi-ap', actor: me });
  const shelfChassisId = newestNode(beforeShelfDevice, working, 'Chassis');
  const shelfDeviceId = newestNode(beforeShelfDevice, working, 'Device');
  working = placeOnShelf(working, shelfChassisId, shelfId, 0, { actor: me });
  const beforeShelfPort = working;
  working = addSketchPort(working, shelfChassisId, { label: 'Et0', connector: 'rj45', service: 'ethernet', face: 'front' }, { actor: me });
  const shelfPortId = newestNode(beforeShelfPort, working, 'PhysicalPort');
  const shelfFar = freeFrontRj45(working, catalogue, 'sw-edge');
  working = connectPorts(working, shelfPortId, shelfFar.portId, { sheath: 'grey' as Sheath }, { actor: me });
  working = tagObject(working, shelfDeviceId, 'shelfgear', { actor: me });

  // `sw-core` bridges its own downlink (to `cam-01`) and its uplink (to
  // `sw-edge`) onto the SAME VLAN 30 domain — the "blank bridge" rule above,
  // now safe: `sw-core` carries exactly these two cabled ports.
  working = setDeviceField(working, camNear.deviceId, 'role', 'switch', { actor: me });

  working = addVlan(
    working,
    { vlanId: 10, name: 'servers', attach: [{ target: { kind: 'port', portId: srv.portId, interfaceName: 'Et0' } }] },
    { actor: me },
  );
  working = addVlan(
    working,
    { vlanId: 30, name: 'cameras', attach: [{ target: { kind: 'port', portId: cam.portId, interfaceName: 'Et0' } }] },
    { actor: me },
  );

  const now = Date.now();
  const trunkIfaceId = formatNodeId('Interface', newUlid(now));
  const trunkUnitId = formatNodeId('LogicalUnit', newUlid(now));
  working = {
    ...working,
    nodes: [
      ...working.nodes,
      { id: trunkIfaceId, existence: newUlid(now), fields: { 'Interface.name': { presence: 'set', prov: newUlid(now), value: trunkFar.label } } },
      {
        id: trunkUnitId,
        existence: newUlid(now),
        fields: {
          'LogicalUnit.index': { presence: 'set', prov: newUlid(now), value: 30 },
          'LogicalUnit.vlan_id': { presence: 'set', prov: newUlid(now), value: '30' },
        },
      },
    ],
    edges: [
      ...working.edges,
      { id: formatEdgeId('HasInterface', newUlid(now)), from: trunkFar.deviceId, to: trunkIfaceId, prov: newUlid(now), fields: {} },
      { id: formatEdgeId('Occupies', newUlid(now)), from: trunkIfaceId, to: trunkFar.portId, prov: newUlid(now), fields: {} },
      { id: formatEdgeId('HasUnit', newUlid(now)), from: trunkIfaceId, to: trunkUnitId, prov: newUlid(now), fields: {} },
    ],
  };

  // A tag on the trunk cable — `design/proposals/cables/cable-filter.dc.html`
  // panel 1's own "Uplinks" tag row.
  const trunkCableId = viewOf(working, catalogue)
    .cables.find((c) => c.ends.some((e) => 'portId' in e && e.portId === trunkNear.portId))!.id;
  working = tagObject(working, trunkCableId, 'uplinks', { actor: me });

  return working;
}

/** The Cables list's own speed measurement, at `count` devices —
 * `seedManyDevicesScene`'s own scene (racks packed to capacity, dev-01
 * cabled to dev-02) plus one VLAN on that same cable, so "tick a VLAN
 * group" has a real one to tick rather than only a type group, which
 * `cableGroups.ts`'s own membership resolution never has to touch
 * `deriveNetworks` for. */
export function seedCableGroupsSpeedScene(catalogue: CatalogueModel[], me: string, count: number): Document {
  const doc = seedManyDevicesScene(catalogue, me, count);
  const a = frontRj45(doc, catalogue, 'dev-01');
  return addVlan(doc, { vlanId: 50, name: 'load', attach: [{ target: { kind: 'port', portId: a.portId, interfaceName: 'up' } }] }, { actor: me });
}

/** The canvas scene with VLAN 20 and an address on the firewall cable, and a tag: the Show-menu scene. */
export function seedShowScene(catalogue: CatalogueModel[], me: string): Document {
  let working = seedCanvasScene(catalogue, me);
  const chassis = (host: string) => viewOf(working, catalogue).racks[0]!.chassis.find((c) => c.hostname === host)!;
  const rj = (host: string, i: number) =>
    chassis(host).ports.filter((p) => p.face === 'front' && p.connector.toLowerCase() === 'rj45').sort((x, y) => naturalLabelCompare(x.label, y.label))[i]!;
  const fwPort = rj('fw-01', 0);
  const corePort = rj('core-sw-01', 10);
  working = addVlan(
    working,
    {
      vlanId: 20,
      name: 'Clients',
      subnet: '10.0.20.0/24',
      gatewayAddress: '10.0.20.1/24',
      attach: [
        { target: { kind: 'port', portId: fwPort.id, interfaceName: fwPort.label }, gateway: true },
        { target: { kind: 'port', portId: corePort.id, interfaceName: corePort.label } },
      ],
    },
    { actor: me },
  );
  return tagObject(working, chassis('fw-01').deviceId, 'edge', { actor: me });
}

/** Successive versions of one design, for the History drive: two devices, a colleague's second device,
 * a cable, then a rename. Each document extends the one before it. */
export function seedHistoryVersions(catalogue: CatalogueModel[], me: string, colleague: string): Document[] {
  const { doc, rackId } = oneRack(catalogue, me);
  const core = catalogue.find((m) => m.model === 'EX4300-48P');
  const acc = catalogue.find((m) => m.model === 'EX2300-48P');
  if (!core || !acc) throw new Error('the drive catalogue fixture has no EX4300-48P or EX2300-48P');
  const v1 = place(doc, catalogue, rackId, core, 40, 'core-01', me);
  const v2 = place(v1, catalogue, rackId, acc, 38, 'acc-01', colleague);
  const a = frontRj45(v2, catalogue, 'core-01');
  const b = frontRj45(v2, catalogue, 'acc-01');
  const v3 = connectPorts(v2, a.portId, b.portId, { sheath: 'blue' as Sheath }, { actor: me });
  const v4 = setDeviceField(v3, a.deviceId, 'hostname', 'core-02', { actor: me });
  return [v1, v2, v3, v4];
}

/** The firmware drive's image ids: real-looking ulids the stubbed server and the chosen versions agree on. */
export const fwImageId = (n: number): string => `01K8FW${String(n).padStart(20, '0')}`;

/** The hashes the stubbed server reports (64 lowercase hex), by image number. */
export const FW_SHA: Record<number, string> = {
  1: '9f2c4b7d1e8a3055c6d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3a41e',
  2: '17be6a02c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c03d9',
  3: '44d1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3b2f0',
  4: 'e83a5f4e3d2c1b0a99887766554433221100ffeeddccbbaa99887766554f5c6b',
  5: '2b70c9d8e7f6a5b4c3d2e1f0091827364554637281900a1b2c3d4e5f6a7b91aa',
};

/**
 * ADR-0064's drive: one rack of captured switches. EX2300-24P: switch-2 on the chosen 23.4R2, switch-1/3/4 behind on
 * 21.4R3-S5, switch-5 held (also 21.4R3-S5), switch-6 never read. An EX2300-48P on the chosen version, two C9300-48P
 * (IOS XE 17.9.4 chosen, one still on 17.9.3) and a DCS-7050SX3-48YC8 (EOS 4.30.2F, chosen). NX-OS has an image and no device.
 */
export function seedFirmwareScene(catalogue: CatalogueModel[], me: string): Document {
  const { doc, rackId } = oneRack(catalogue, me, 24);
  const find = (model: string) => {
    const m = catalogue.find((c) => c.model === model);
    if (!m) throw new Error(`the drive catalogue fixture has no ${model}`);
    return m;
  };
  let working = doc;
  let u = 2;
  const add = (model: string, hostname: string, platform: string, osVersion: string) => {
    working = place(working, catalogue, rackId, find(model), u, hostname, me);
    u += 1;
    const dev = firstRack(working, catalogue).chassis.find((c) => c.hostname === hostname)!.deviceId;
    const b = begin(working, { actor: me });
    if (platform) setNodeField(b, dev, 'Device.platform', platform);
    if (osVersion) setNodeField(b, dev, 'Device.os_version', osVersion);
    working = finish(b, 'drive: captured');
    return dev;
  };
  add('EX2300-24P', 'switch-1', 'junos-ex', '21.4R3-S5');
  add('EX2300-24P', 'switch-2', 'junos-ex', '23.4R2');
  add('EX2300-24P', 'switch-3', 'junos-ex', '21.4R3-S5');
  add('EX2300-24P', 'switch-4', 'junos-ex', '21.4R3-S5');
  const held = add('EX2300-24P', 'switch-5', 'junos-ex', '21.4R3-S5');
  add('EX2300-24P', 'switch-6', 'junos-ex', '');
  add('EX2300-48P', 'switch-7', 'junos-ex', '23.4R2');
  add('C9300-48P', 'dist-1', 'ios-xe', '17.9.3');
  add('C9300-48P', 'dist-2', 'ios-xe', '17.9.4');
  add('DCS-7050SX3-48YC8', 'leaf-1', 'eos', '4.30.2F');
  const choose = (model: string, version: string, platform: string, n: number) => {
    working = setTarget(working, model, { version, platform, image: fwImageId(n), imageSha256: FW_SHA[n]! }, { actor: me });
  };
  choose('EX2300-24P', '23.4R2', 'junos-ex', 1);
  choose('EX2300-48P', '23.4R2', 'junos-ex', 1);
  choose('C9300-48P', '17.9.4', 'ios-xe', 3);
  choose('DCS-7050SX3-48YC8', '4.30.2F', 'eos', 5);
  working = setFirmwareHold(working, held, 'Lab rig, kept on old version for a class', { actor: me });
  return working;
}

/** The cable-suggestions mockup (r15-f3): switch-1 and four neighbours as boxes on the canvas, no cables yet.
 * ap-office has a numbered port, so its line from an LLDP list is left for the person. */
export function seedSuggestScene(me: string): Document {
  let doc = createPremises(emptyDocument(), { actor: me }).doc;
  const boxes: [string, number, number, string[]][] = [
    ['switch-1', 80, 80, ['ge-0/0/1', 'ge-0/0/4', 'ge-0/0/7', 'ge-0/0/9']],
    ['router-1', 520, 40, ['ether2']],
    ['ap-lobby', 500, 280, ['eth0']],
    ['nas-1', 120, 420, ['eth0']],
    ['ap-office', 600, 480, ['1']],
  ];
  for (const [hostname, x, y, ports] of boxes) {
    const made = createFreeBox(doc, { hostname, x, y, actor: me });
    doc = made.doc;
    for (const label of ports) doc = addSketchPort(doc, made.chassisId, { label, connector: 'rj45', face: 'front' }, { actor: me });
  }
  return doc;
}
