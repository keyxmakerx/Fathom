// Scenes for the drawing drives, copied into client/src/ as drive-seed.ts only
// while a drive runs. Built with the real document commands, so each is a real Document.

import { parseCatalogueModel, type CatalogueModel } from './api/catalogue';
import { createPremises } from './components/racks/emptyDesign';
import { connectPorts, type Sheath } from './document/cables';
import {
  addSketchPort,
  createRack,
  createSketchDevice,
  createSurface,
  fixTo,
  placeChassis,
  type CreateSurfaceOptions,
} from './document/commands';
import { setDeviceField } from './document/edit';
import { addNote, type NoteHow } from './document/notes';
import { emptyDocument, parseNodeId, type Document, type NodeKind } from './document/model';
import { viewOf } from './document/view';

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
  const chassis = firstRack(working, catalogue).chassis.find((c) => c.positionU === positionU)!;
  working = setDeviceField(working, chassis.deviceId, 'hostname', hostname, { actor });
  return working;
}

/** The device's lowest-numbered front RJ45 port, so both cable ends always
 * pair. Port order in the view follows random ids, so "first" is not stable. */
function frontRj45(doc: Document, catalogue: CatalogueModel[], hostname: string): { deviceId: string; portId: string } {
  const chassis = firstRack(doc, catalogue).chassis.find((c) => c.hostname === hostname)!;
  const ports = chassis.ports
    .filter((p) => p.face === 'front' && p.connector === 'rj45')
    .sort((x, y) => x.label.localeCompare(y.label, undefined, { numeric: true }));
  if (ports.length === 0) throw new Error(`${hostname} has no front rj45 port`);
  return { deviceId: chassis.deviceId, portId: ports[0].id };
}

function oneRack(catalogue: CatalogueModel[], actor: string): { doc: Document; rackId: string; premisesId: string } {
  let doc = emptyDocument();
  const premises = createPremises(doc, { actor });
  doc = createRack(premises.doc, premises.premisesId, {
    label: 'A-04',
    heightU: 42,
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
