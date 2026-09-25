// Scenes for the drawing drives, copied into client/src/ as drive-seed.ts only
// while a drive runs. Built with the real document commands, so each is a real Document.

import { parseCatalogueModel, type CatalogueModel } from './api/catalogue';
import { createPremises } from './components/racks/emptyDesign';
import { connectPorts, type Sheath } from './document/cables';
import { createRack, placeChassis } from './document/commands';
import { setDeviceField } from './document/edit';
import { addNote, type NoteHow } from './document/notes';
import { emptyDocument, type Document } from './document/model';
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

function oneRack(catalogue: CatalogueModel[], actor: string): { doc: Document; rackId: string } {
  let doc = emptyDocument();
  const premises = createPremises(doc, { actor });
  doc = createRack(premises.doc, premises.premisesId, {
    label: 'A-04',
    heightU: 42,
    unitNumbering: 'ascending',
    actor,
  });
  return { doc, rackId: firstRack(doc, catalogue).id };
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
