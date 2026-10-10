// Sample networks (ADR-0061 round 10, lessons B: "sample networks first"; r15-start). A sample is data in
// `corpus/samples/`, reviewed like a rule, and this module turns it into a Document with the same commands a person
// uses by hand, so a sample can hold nothing the editor could not. Each device names a catalogue model; one the
// catalogue does not hold (or holds without the ports the sample cables) is drawn as a sketch with the sample's own
// ports, labelled the way the catalogue labels them, so the sample opens either way.
import type { CatalogueModel } from '../../api/catalogue';
import { connectPorts, connectToOutside, isSheath, type Sheath } from '../../document/cables';
import {
  addSketchPort,
  createRack,
  createShelf,
  createSketchDevice,
  createSurface,
  equipFromCatalogue,
  isSurfaceForm,
  movePlacement,
  placeChassis,
} from '../../document/commands';
import { connectorTokenOf } from '../../document/compat';
import { isDeviceRole, setDeviceField } from '../../document/edit';
import { edgesIn, edgesOut, emptyDocument, findNode, parseNodeId, readPhysicalPortFields, type Document } from '../../document/model';
import { addSubnet, addVlan, type Actor } from '../../document/networks';
import { createPremises } from '../racks/emptyDesign';

export interface SamplePort {
  label: string;
  connector: string;
}

export interface SampleDevice {
  hostname: string;
  role: string;
  catalogue?: { vendor: string; model: string };
  /** On a surface, `x`/`y` are millimetres from its left edge and up from its foot. */
  place: { rack: number } | { shelf: string; slot: number } | { surface: string; x?: number; y?: number };
  ports: SamplePort[];
  face: 'front' | 'rear';
}

export interface SampleCable {
  a: string;
  b?: string;
  outside?: string;
  sheath?: string;
  label?: string;
}

export interface SampleSource {
  claim: string;
  cite: string;
  url: string;
  read_on: string;
}

export interface SampleSpec {
  id: string;
  name: string;
  summary: string;
  sources: SampleSource[];
  rack: { label: string; heightU: number; numbering: 'ascending' | 'descending' };
  shelves: { key: string; label: string; positionU: number }[];
  surfaces: { key: string; label: string; form: string; widthMm?: number; heightMm?: number }[];
  devices: SampleDevice[];
  cables: SampleCable[];
  vlans: { id: number; name: string; description?: string; access: string[] }[];
  subnets: { prefix: string; hosts: { port: string; address: string; name?: string }[] }[];
  /** Two devices a trace runs between, end to end; the sample's own test holds it to that. */
  trace: { from: string; to: string };
}

const sampleFiles = import.meta.glob('../../../../corpus/samples/*.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

/** Every sample in `corpus/samples/`, by id. */
export function samples(): SampleSpec[] {
  return Object.values(sampleFiles).map((text) => JSON.parse(text) as SampleSpec);
}

export function sample(id: string): SampleSpec {
  const found = samples().find((s) => s.id === id);
  if (!found) throw new Error(`no sample "${id}" in corpus/samples`);
  return found;
}

/** The sample's catalogue references, each once. */
export function sampleModels(spec: SampleSpec): { vendor: string; model: string }[] {
  const seen = new Map<string, { vendor: string; model: string }>();
  for (const d of spec.devices) if (d.catalogue) seen.set(modelKey(d.catalogue.vendor, d.catalogue.model), d.catalogue);
  return [...seen.values()];
}

export const modelKey = (vendor: string, model: string): string => `${vendor}/${model}`.toLowerCase();

export interface BuiltSample {
  doc: Document;
  /** Hostname to Device id. */
  devices: Map<string, string>;
  /** Hostnames drawn from the catalogue; the rest are sketches. */
  catalogued: string[];
}

/** True when `model` offers every port the sample uses on `device`, by label and connector. */
function modelFits(model: CatalogueModel, device: SampleDevice): boolean {
  const offered = new Set<string>();
  for (const plate of model.faceplates) for (const p of plate.ports) offered.add(`${p.name ?? String(p.number)}|${connectorTokenOf(p.kind)}`);
  return device.ports.every((p) => offered.has(`${p.label}|${p.connector}`));
}

function freshId(before: Document, after: Document, kind: string): string {
  const had = new Set(before.nodes.map((n) => n.id));
  const node = after.nodes.find((n) => !had.has(n.id) && parseNodeId(n.id).kind === kind);
  if (!node) throw new Error(`the sample builder expected a new ${kind}`);
  return node.id;
}

function chassisOf(doc: Document, deviceId: string): string {
  const edge = edgesOut(doc, deviceId, 'HasChassis')[0];
  if (!edge) throw new Error(`device ${deviceId} has no chassis`);
  return edge.to;
}

/** `hostname:label` to a PhysicalPort id; an RJ45 or named port before any other with the same label. */
function portOf(doc: Document, devices: Map<string, string>, spec: SampleSpec, ref: string): string {
  const [hostname, label] = ref.split(':');
  const deviceId = devices.get(hostname);
  const device = spec.devices.find((d) => d.hostname === hostname);
  if (!deviceId || !device || label === undefined) throw new Error(`the sample names an unknown port "${ref}"`);
  const want = device.ports.find((p) => p.label === label);
  if (!want) throw new Error(`the sample uses port "${ref}" without listing it`);
  const chassisId = chassisOf(doc, deviceId);
  for (const e of edgesOut(doc, chassisId, 'HasPort')) {
    const node = findNode(doc, e.to);
    if (!node || node.absentSince !== undefined) continue;
    const f = readPhysicalPortFields(node);
    if (f.label === label && f.connector === want.connector) return node.id;
  }
  throw new Error(`no port "${ref}" on the drawn device`);
}

/**
 * The sample as a fresh Document. `models` is whatever the catalogue answered, keyed by `modelKey`; a device whose
 * model is missing or lacks a port the sample uses is drawn as a sketch instead.
 */
export function buildSample(spec: SampleSpec, models: ReadonlyMap<string, CatalogueModel>, opts?: Actor): BuiltSample {
  const premises = createPremises(emptyDocument(), opts);
  let doc = premises.doc;

  let next = createRack(doc, premises.premisesId, { ...opts, label: spec.rack.label, heightU: spec.rack.heightU, unitNumbering: spec.rack.numbering });
  const rackId = freshId(doc, next, 'Rack');
  doc = next;

  const shelves = new Map<string, string>();
  for (const s of spec.shelves) {
    next = createShelf(doc, rackId, { ...opts, label: s.label, positionU: s.positionU });
    shelves.set(s.key, freshId(doc, next, 'PassiveNode'));
    doc = next;
  }

  const surfaces = new Map<string, string>();
  for (const s of spec.surfaces) {
    if (!isSurfaceForm(s.form)) throw new Error(`surface "${s.key}" has form "${s.form}"`);
    next = createSurface(doc, premises.premisesId, { ...opts, label: s.label, form: s.form, widthMm: s.widthMm, heightMm: s.heightMm });
    surfaces.set(s.key, freshId(doc, next, 'Surface'));
    doc = next;
  }

  const devices = new Map<string, string>();
  const catalogued: string[] = [];
  for (const d of spec.devices) {
    const model = d.catalogue ? models.get(modelKey(d.catalogue.vendor, d.catalogue.model)) : undefined;
    const fits = model !== undefined && modelFits(model, d);
    let deviceId: string;
    if (fits && 'rack' in d.place) {
      // Through placeChassis so the device takes the model's height in the rack.
      next = placeChassis(doc, rackId, model, d.place.rack, 'front', opts);
      deviceId = freshId(doc, next, 'Device');
      doc = next;
    } else {
      next = createSketchDevice(doc, opts);
      deviceId = freshId(doc, next, 'Device');
      doc = next;
      const chassisId = chassisOf(doc, deviceId);
      if (fits) {
        doc = equipFromCatalogue(doc, chassisId, model, opts);
      } else {
        for (const p of d.ports) doc = addSketchPort(doc, chassisId, { label: p.label, connector: p.connector, face: d.face }, opts);
      }
      const place = d.place;
      if ('rack' in place) doc = movePlacement(doc, chassisId, { kind: 'rack', rackId, positionU: place.rack, face: 'front' }, opts);
      else if ('shelf' in place) doc = movePlacement(doc, chassisId, { kind: 'shelf', shelfId: shelves.get(place.shelf)!, slot: place.slot }, opts);
      else doc = movePlacement(doc, chassisId, { kind: 'surface', surfaceId: surfaces.get(place.surface)!, xMm: place.x ?? null, yMm: place.y ?? null }, opts);
    }
    if (fits) catalogued.push(d.hostname);
    doc = setDeviceField(doc, deviceId, 'hostname', d.hostname, opts);
    if (isDeviceRole(d.role)) doc = setDeviceField(doc, deviceId, 'role', d.role, opts);
    devices.set(d.hostname, deviceId);
  }

  for (const c of spec.cables) {
    const sheath: Sheath | undefined = c.sheath !== undefined && isSheath(c.sheath) ? c.sheath : undefined;
    const a = portOf(doc, devices, spec, c.a);
    if (c.outside !== undefined) doc = connectToOutside(doc, a, { label: c.outside, sheath }, opts);
    else if (c.b !== undefined) doc = connectPorts(doc, a, portOf(doc, devices, spec, c.b), { sheath, label: c.label }, opts);
  }

  for (const v of spec.vlans) {
    doc = addVlan(
      doc,
      {
        vlanId: v.id,
        name: v.name,
        description: v.description,
        attach: v.access.map((ref) => ({ target: { kind: 'port' as const, portId: portOf(doc, devices, spec, ref), interfaceName: interfaceName(ref) } })),
      },
      opts,
    );
  }

  for (const s of spec.subnets) {
    doc = addSubnet(
      doc,
      {
        prefix: s.prefix,
        attach: s.hosts.map((h) => ({ target: targetFor(doc, devices, spec, h.port), address: h.address, name: h.name })),
      },
      opts,
    );
  }

  return { doc, devices, catalogued };
}

/** An interface named for its port: `eth0` stays `eth0`, a numbered port `1` becomes `port1`. */
function interfaceName(ref: string): string {
  const label = ref.split(':')[1] ?? '';
  return /^\d/.test(label) ? `port${label}` : label;
}

/** The port's existing interface when a VLAN already made one, else a new one on the port. */
function targetFor(
  doc: Document,
  devices: Map<string, string>,
  spec: SampleSpec,
  ref: string,
): { kind: 'interface'; interfaceId: string } | { kind: 'port'; portId: string; interfaceName: string } {
  const portId = portOf(doc, devices, spec, ref);
  const occupant = edgesIn(doc, portId, 'Occupies').find((e) => e.absentSince === undefined);
  return occupant ? { kind: 'interface', interfaceId: occupant.from } : { kind: 'port', portId, interfaceName: interfaceName(ref) };
}
