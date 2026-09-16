import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../api/catalogue';
import {
  IncompatibleConnectorError,
  MEDIA_VALUES,
  OWNERSHIP_VALUES,
  PortAlreadyTerminatedError,
  SHEATH_VALUES,
  connectPorts,
  connectToOutside,
  disconnect,
  isCableMedia,
  isCableOwnership,
  isSheath,
  setCableField,
} from './cables';
import { compatible } from './compat';
import { UnknownReferenceError, createRack, placeChassis } from './commands';
import { FieldValueError } from './edit';
import {
  edgesIn,
  edgesOut,
  emptyDocument,
  findNode,
  formatNodeId,
  readPhysicalPortFields,
  type Document,
} from './model';
import { readPlain, writePlain } from './plain';
import { newUlid } from './ulid';
import { viewOf } from './view';

const NOW = 1_700_000_000_000;

function docWithPremises(): { doc: Document; premisesId: string } {
  const premisesId = formatNodeId('Premises', newUlid(NOW));
  const doc: Document = {
    ...emptyDocument(),
    nodes: [
      {
        id: premisesId,
        existence: newUlid(NOW),
        fields: { 'Premises.label': { presence: 'set', prov: newUlid(NOW), value: 'Riverside CO' } },
      },
    ],
  };
  return { doc, premisesId };
}

function rackOf(heightU: number): { doc: Document; premisesId: string; rackId: string } {
  const { doc, premisesId } = docWithPremises();
  const withRack = createRack(doc, premisesId, { label: 'R1', heightU, unitNumbering: 'ascending', now: NOW });
  const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
  return { doc: withRack, premisesId, rackId };
}

// A fixture whose faceplate `kind` tokens are already the schema's own
// `PhysicalPort.connector` spelling (lowercase — `rj45`, `lc`) rather than a
// real catalogue's raw `"RJ45"` (`crates/fathom-corpus/src/catalogue.rs`'s
// `PortKind::token()`). `placeChassis` carries a faceplate's `kind` through
// verbatim (`commands.ts`'s own doc on that loop), so a real catalogue
// fixture would write `"RJ45"` — which `compat.ts`'s table, built to the
// schema's lowercase tokens per this session's brief, would then refuse to
// pair with itself. Noted in this session's report as a reconciliation point
// between `placeChassis` (unowned here, except for its PSU-inlet addition)
// and `compat.ts`; this fixture sidesteps it to test `cables.ts` itself.
const PORT_MODEL: CatalogueModel = {
  vendor: 'test',
  model: 'PORT-BOX',
  rackUnits: 1,
  reviewedBy: 'reviewer',
  source: { cite: 'fixture', readOn: '2026-09-16' },
  psuSlots: [
    { name: 'PSU0', hotSwap: true, face: 'rear', position: { row: 'single', column: 0 } },
    { name: 'PSU1', hotSwap: true, face: 'rear', position: { row: 'single', column: 1 } },
  ],
  faceplates: [
    {
      face: 'front',
      portCount: 2,
      ports: [
        { kind: 'rj45', number: 0, uplink: false, row: 'single', column: 0, groupGapBefore: false },
        { kind: 'lc', number: 1, uplink: false, row: 'single', column: 1, groupGapBefore: false },
      ],
    },
  ],
};

const NO_PSU_MODEL: CatalogueModel = { ...PORT_MODEL, model: 'PORT-BOX-NOPSU', psuSlots: [] };

function portByConnector(doc: Document, chassisId: string, connector: string): string {
  const port = edgesOut(doc, chassisId, 'HasPort')
    .map((e) => e.to)
    .find((id) => readPhysicalPortFields(findNode(doc, id)!).connector === connector);
  if (!port) throw new Error(`fixture has no ${connector} port on ${chassisId}`);
  return port;
}

function twoChassis(): { doc: Document; premisesId: string; rackId: string; chassisA: string; chassisB: string } {
  const { doc, premisesId, rackId } = rackOf(42);
  const withA = placeChassis(doc, rackId, PORT_MODEL, 1, 'front', { now: NOW });
  const chassisA = edgesIn(withA, rackId, 'MountedIn')[0].from;
  const withB = placeChassis(withA, rackId, PORT_MODEL, 2, 'front', { now: NOW });
  const chassisB = edgesIn(withB, rackId, 'MountedIn').find((e) => e.from !== chassisA)!.from;
  return { doc: withB, premisesId, rackId, chassisA, chassisB };
}

describe('compat.ok', () => {
  it('pairs rj45-rj45 as copper cat6', () => {
    expect(compatible('rj45', 'rj45')).toEqual({ ok: true, kind: 'copper', media: 'cat6' });
  });
  it('pairs lc-lc as fibre mmf', () => {
    expect(compatible('lc', 'lc')).toEqual({ ok: true, kind: 'fibre', media: 'mmf' });
  });
  it('pairs a matching optical pair as a copper DAC (twinax)', () => {
    for (const c of ['sfp', 'sfp_plus', 'sfp28', 'qsfp', 'qsfp28']) {
      expect(compatible(c, c)).toEqual({ ok: true, kind: 'copper', media: 'twinax' });
    }
  });
  it('pairs c13-c14 either order as power', () => {
    expect(compatible('c13', 'c14')).toEqual({ ok: true, kind: 'power', media: 'power' });
    expect(compatible('c14', 'c13')).toEqual({ ok: true, kind: 'power', media: 'power' });
  });
  it('refuses an unlisted pair, naming what is missing', () => {
    const result = compatible('rj45', 'lc');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('rj45');
      expect(result.reason).toContain('lc');
    }
  });
});

describe('connectPorts', () => {
  it('creates a Cable and two Terminates edges, media defaulted from the connector pair', () => {
    const { doc, chassisA, chassisB } = twoChassis();
    const fromPort = portByConnector(doc, chassisA, 'rj45');
    const toPort = portByConnector(doc, chassisB, 'rj45');

    const next = connectPorts(doc, fromPort, toPort, { sheath: 'blue' }, { now: NOW });

    const termsIn = edgesIn(next, fromPort, 'Terminates');
    expect(termsIn).toHaveLength(1);
    const cableId = termsIn[0].from;
    const cable = findNode(next, cableId)!;
    expect(cable.fields['Cable.media']).toMatchObject({ presence: 'set', value: 'cat6' });
    expect(cable.fields['Cable.sheath']).toMatchObject({ presence: 'set', value: 'blue' });

    const allTerms = edgesOut(next, cableId, 'Terminates');
    expect(allTerms).toHaveLength(2);
    const ends = allTerms.map((e) => [e.to, e.fields['Terminates.end']?.value]);
    expect(ends).toContainEqual([fromPort, 'a']);
    expect(ends).toContainEqual([toPort, 'b']);

    // No HasCable edge is ever written — `HasCable` is root-containment
    // (`cables.ts`'s module doc); the Cable is a bare root node.
    expect(next.edges.some((e) => e.id.startsWith('has-cable:'))).toBe(false);
  });

  it('honours an explicit media override', () => {
    const { doc, chassisA, chassisB } = twoChassis();
    const fromPort = portByConnector(doc, chassisA, 'rj45');
    const toPort = portByConnector(doc, chassisB, 'rj45');
    const next = connectPorts(doc, fromPort, toPort, { media: 'cat6a' }, { now: NOW });
    const cableId = edgesIn(next, fromPort, 'Terminates')[0].from;
    expect(findNode(next, cableId)!.fields['Cable.media']).toMatchObject({ value: 'cat6a' });
  });

  it('refuses an invalid sheath', () => {
    const { doc, chassisA, chassisB } = twoChassis();
    const fromPort = portByConnector(doc, chassisA, 'rj45');
    const toPort = portByConnector(doc, chassisB, 'rj45');
    expect(() =>
      connectPorts(doc, fromPort, toPort, { sheath: 'chartreuse' as never }, { now: NOW }),
    ).toThrow(FieldValueError);
  });

  it('refuses a port that already terminates a cable', () => {
    const { doc, chassisA, chassisB } = twoChassis();
    const fromPort = portByConnector(doc, chassisA, 'rj45');
    const toPort = portByConnector(doc, chassisB, 'rj45');
    const once = connectPorts(doc, fromPort, toPort, {}, { now: NOW });
    const otherPort = portByConnector(doc, chassisB, 'lc'); // wrong connector, but the refusal fires first
    expect(() => connectPorts(once, fromPort, otherPort, {}, { now: NOW })).toThrow(
      PortAlreadyTerminatedError,
    );
  });

  it('refuses an incompatible connector pair', () => {
    const { doc, chassisA, chassisB } = twoChassis();
    const fromPort = portByConnector(doc, chassisA, 'rj45');
    const toPort = portByConnector(doc, chassisB, 'lc');
    expect(() => connectPorts(doc, fromPort, toPort, {}, { now: NOW })).toThrow(IncompatibleConnectorError);
  });

  it('refuses an unknown port', () => {
    const { doc, chassisA } = twoChassis();
    const fromPort = portByConnector(doc, chassisA, 'rj45');
    expect(() =>
      connectPorts(doc, fromPort, 'physical-port:01ARZ3NDEKTSV4RRFFQ69G5FAV', {}, { now: NOW }),
    ).toThrow(UnknownReferenceError);
  });

  it('does not mutate its input', () => {
    const { doc, chassisA, chassisB } = twoChassis();
    const fromPort = portByConnector(doc, chassisA, 'rj45');
    const toPort = portByConnector(doc, chassisB, 'rj45');
    const before = JSON.stringify(doc);
    connectPorts(doc, fromPort, toPort, {}, { now: NOW });
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('disconnect', () => {
  it('tombstones the cable and its Terminates edges', () => {
    const { doc, chassisA, chassisB } = twoChassis();
    const fromPort = portByConnector(doc, chassisA, 'rj45');
    const toPort = portByConnector(doc, chassisB, 'rj45');
    const connected = connectPorts(doc, fromPort, toPort, {}, { now: NOW });
    const cableId = edgesIn(connected, fromPort, 'Terminates')[0].from;

    const next = disconnect(connected, cableId, { now: NOW });
    expect(findNode(next, cableId)?.absentSince).toBe(NOW);
    expect(edgesIn(next, fromPort, 'Terminates')).toHaveLength(0);
    expect(edgesIn(next, toPort, 'Terminates')).toHaveLength(0);
  });

  it('refuses an unknown cable', () => {
    const { doc } = twoChassis();
    expect(() => disconnect(doc, 'cable:01ARZ3NDEKTSV4RRFFQ69G5FAV', { now: NOW })).toThrow(
      UnknownReferenceError,
    );
  });
});

describe('setCableField', () => {
  function cableFixture(): { doc: Document; cableId: string } {
    const { doc, chassisA, chassisB } = twoChassis();
    const fromPort = portByConnector(doc, chassisA, 'rj45');
    const toPort = portByConnector(doc, chassisB, 'rj45');
    const connected = connectPorts(doc, fromPort, toPort, {}, { now: NOW });
    const cableId = edgesIn(connected, fromPort, 'Terminates')[0].from;
    return { doc: connected, cableId };
  }

  it('sets and clears label', () => {
    const { doc, cableId } = cableFixture();
    const set = setCableField(doc, cableId, 'label', 'A1-to-B3', { now: NOW });
    expect(findNode(set, cableId)!.fields['Cable.label']).toMatchObject({ value: 'A1-to-B3' });
    const cleared = setCableField(set, cableId, 'label', null, { now: NOW });
    expect(findNode(cleared, cableId)!.fields['Cable.label']).toMatchObject({ presence: 'absent' });
  });

  it('validates sheath against SHEATH_VALUES', () => {
    const { doc, cableId } = cableFixture();
    for (const s of SHEATH_VALUES) {
      expect(() => setCableField(doc, cableId, 'sheath', s, { now: NOW })).not.toThrow();
    }
    expect(() => setCableField(doc, cableId, 'sheath', 'mauve', { now: NOW })).toThrow(FieldValueError);
  });

  it('validates media against MEDIA_VALUES', () => {
    const { doc, cableId } = cableFixture();
    for (const m of MEDIA_VALUES) {
      expect(() => setCableField(doc, cableId, 'media', m, { now: NOW })).not.toThrow();
    }
    expect(() => setCableField(doc, cableId, 'media', 'cat9', { now: NOW })).toThrow(FieldValueError);
  });

  it('validates ownership against OWNERSHIP_VALUES', () => {
    const { doc, cableId } = cableFixture();
    for (const o of OWNERSHIP_VALUES) {
      expect(() => setCableField(doc, cableId, 'ownership', o, { now: NOW })).not.toThrow();
    }
    expect(() => setCableField(doc, cableId, 'ownership', 'leased', { now: NOW })).toThrow(FieldValueError);
  });

  it('sets length_m as a u32', () => {
    const { doc, cableId } = cableFixture();
    const next = setCableField(doc, cableId, 'length_m', 12, { now: NOW });
    expect(findNode(next, cableId)!.fields['Cable.length_m']).toMatchObject({ value: 12 });
    expect(() => setCableField(doc, cableId, 'length_m', -1, { now: NOW })).toThrow();
  });

  it('refuses an unknown cable', () => {
    expect(() =>
      setCableField(twoChassis().doc, 'cable:01ARZ3NDEKTSV4RRFFQ69G5FAV', 'label', 'x', { now: NOW }),
    ).toThrow(UnknownReferenceError);
  });
});

describe('isSheath / isCableMedia / isCableOwnership', () => {
  it('accept exactly their declared vocabularies', () => {
    expect(SHEATH_VALUES.every(isSheath)).toBe(true);
    expect(isSheath('mauve')).toBe(false);
    expect(MEDIA_VALUES.every(isCableMedia)).toBe(true);
    expect(isCableMedia('cat9')).toBe(false);
    expect(OWNERSHIP_VALUES.every(isCableOwnership)).toBe(true);
    expect(isCableOwnership('leased')).toBe(false);
  });
});

describe('connectToOutside', () => {
  it('creates an ExternalPeer owned by the Premises and a Cable to it', () => {
    const { doc, premisesId, chassisA } = twoChassis();
    const fromPort = portByConnector(doc, chassisA, 'rj45');

    const next = connectToOutside(doc, fromPort, { label: 'Metro-E to Site B', sheath: 'yellow' }, { now: NOW });

    const term = edgesIn(next, fromPort, 'Terminates')[0];
    const cableId = term.from;
    const cable = findNode(next, cableId)!;
    expect(cable.fields['Cable.sheath']).toMatchObject({ value: 'yellow' });
    expect(cable.fields['Cable.media']).toBeUndefined(); // unmodelled far end — never guessed

    const farTerm = edgesOut(next, cableId, 'Terminates').find((e) => e.id !== term.id)!;
    const peer = findNode(next, farTerm.to)!;
    expect(peer.fields['ExternalPeer.label']).toMatchObject({ value: 'Metro-E to Site B' });

    const hasPeer = edgesIn(next, peer.id, 'HasExternalPeer');
    expect(hasPeer).toHaveLength(1);
    expect(hasPeer[0].from).toBe(premisesId);
  });

  it('refuses a port that already terminates a cable', () => {
    const { doc, chassisA, chassisB } = twoChassis();
    const fromPort = portByConnector(doc, chassisA, 'rj45');
    const toPort = portByConnector(doc, chassisB, 'rj45');
    const connected = connectPorts(doc, fromPort, toPort, {}, { now: NOW });
    expect(() => connectToOutside(connected, fromPort, { label: 'x' }, { now: NOW })).toThrow(
      PortAlreadyTerminatedError,
    );
  });

  it('refuses an unknown port', () => {
    const { doc } = twoChassis();
    expect(() =>
      connectToOutside(doc, 'physical-port:01ARZ3NDEKTSV4RRFFQ69G5FAV', { label: 'x' }, { now: NOW }),
    ).toThrow(UnknownReferenceError);
  });
});

describe('view: PortView.cable and ClosetView.cables', () => {
  it('resolves an inside-closet cable end on both ports, outsideCloset false', () => {
    const { doc, chassisA, chassisB } = twoChassis();
    const fromPort = portByConnector(doc, chassisA, 'rj45');
    const toPort = portByConnector(doc, chassisB, 'rj45');
    const connected = connectPorts(doc, fromPort, toPort, { sheath: 'green' }, { now: NOW });

    const view = viewOf(connected, [PORT_MODEL]);
    const chassisAView = view.racks[0].chassis.find((c) => c.id === chassisA)!;
    const portView = chassisAView.ports.find((p) => p.id === fromPort)!;
    expect(portView.cable).not.toBeNull();
    expect(portView.cable!.farPortId).toBe(toPort);
    expect(portView.cable!.farChassisId).toBe(chassisB);
    expect(portView.cable!.outsideCloset).toBe(false);

    expect(view.cables).toHaveLength(1);
    const cableView = view.cables[0];
    expect(cableView.kind).toBe('copper');
    expect(cableView.media).toBe('cat6');
    expect(cableView.sheath).toBe('green');
    expect(cableView.ends).toHaveLength(2);
    expect(cableView.ends).toContainEqual({ portId: fromPort, chassisId: chassisA, rackId: view.racks[0].id });
    expect(cableView.ends).toContainEqual({ portId: toPort, chassisId: chassisB, rackId: view.racks[0].id });
  });

  it('marks an ExternalPeer end outsideCloset and records it in ClosetView.cables', () => {
    const { doc, chassisA } = twoChassis();
    const fromPort = portByConnector(doc, chassisA, 'rj45');
    const next = connectToOutside(doc, fromPort, { label: 'Upstream' }, { now: NOW });

    const view = viewOf(next, [PORT_MODEL]);
    const chassisAView = view.racks[0].chassis.find((c) => c.id === chassisA)!;
    const portView = chassisAView.ports.find((p) => p.id === fromPort)!;
    expect(portView.cable!.outsideCloset).toBe(true);
    expect(portView.cable!.farPortId).toBeNull();
    expect(portView.cable!.farChassisId).toBeNull();

    expect(view.cables).toHaveLength(1);
    expect(view.cables[0].ends).toContainEqual({ outside: true, label: 'Upstream' });
  });

  it('a free port has cable: null', () => {
    const { doc, chassisA } = twoChassis();
    const view = viewOf(doc, [PORT_MODEL]);
    const chassisAView = view.racks[0].chassis.find((c) => c.id === chassisA)!;
    expect(chassisAView.ports.every((p) => p.cable === null)).toBe(true);
  });
});

describe('view: ChassisView.psuInlets and singleFed', () => {
  it('exposes the c14 inlets kept out of the faceplate ports array', () => {
    const { doc, chassisA } = twoChassis();
    const view = viewOf(doc, [PORT_MODEL]);
    const chassisAView = view.racks[0].chassis.find((c) => c.id === chassisA)!;
    expect(chassisAView.psuInlets).toHaveLength(2);
    expect(chassisAView.psuInlets.every((p) => p.connector === 'c14')).toBe(true);
    expect(chassisAView.ports.some((p) => p.connector === 'c14')).toBe(false);
  });

  it('is false with zero of two inlets fed', () => {
    const { doc, chassisA } = twoChassis();
    const view = viewOf(doc, [PORT_MODEL]);
    expect(view.racks[0].chassis.find((c) => c.id === chassisA)!.singleFed).toBe(false);
  });

  it('is true with exactly one of two inlets fed', () => {
    const { doc, chassisA } = twoChassis();
    const inletA = doc.nodes
      .filter((n) => n.absentSince === undefined)
      .find((n) => edgesIn(doc, n.id, 'HasPort').some((e) => e.from === chassisA) && readPhysicalPortFields(n).connector === 'c14')!;
    // Feed one inlet from a PDU-style c13 outlet elsewhere in the document.
    const pduPort = formatNodeId('PhysicalPort', newUlid(NOW));
    const withPdu: Document = {
      ...doc,
      nodes: [
        ...doc.nodes,
        {
          id: pduPort,
          existence: newUlid(NOW),
          fields: {
            'PhysicalPort.connector': { presence: 'set', prov: newUlid(NOW), value: 'c13' },
            'PhysicalPort.label': { presence: 'set', prov: newUlid(NOW), value: 'PDU 1' },
          },
        },
      ],
    };
    const fed = connectPorts(withPdu, inletA.id, pduPort, {}, { now: NOW });
    const view = viewOf(fed, [PORT_MODEL]);
    expect(view.racks[0].chassis.find((c) => c.id === chassisA)!.singleFed).toBe(true);
  });

  it('is false with two of two inlets fed', () => {
    const { doc, chassisA } = twoChassis();
    const inlets = doc.nodes.filter(
      (n) =>
        n.absentSince === undefined &&
        edgesIn(doc, n.id, 'HasPort').some((e) => e.from === chassisA) &&
        readPhysicalPortFields(n).connector === 'c14',
    );
    expect(inlets).toHaveLength(2);
    let working = doc;
    let pduNodes: Array<{ id: string }> = [];
    for (const inlet of inlets) {
      const pduPort = formatNodeId('PhysicalPort', newUlid(NOW));
      working = {
        ...working,
        nodes: [
          ...working.nodes,
          {
            id: pduPort,
            existence: newUlid(NOW),
            fields: {
              'PhysicalPort.connector': { presence: 'set', prov: newUlid(NOW), value: 'c13' },
              'PhysicalPort.label': { presence: 'set', prov: newUlid(NOW), value: `PDU ${pduNodes.length + 1}` },
            },
          },
        ],
      };
      working = connectPorts(working, inlet.id, pduPort, {}, { now: NOW });
      pduNodes.push({ id: pduPort });
    }
    const view = viewOf(working, [PORT_MODEL]);
    expect(view.racks[0].chassis.find((c) => c.id === chassisA)!.singleFed).toBe(false);
  });

  it('a single inlet, fed, is not single-fed', () => {
    const { doc, premisesId } = docWithPremises();
    const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 4, unitNumbering: 'ascending', now: NOW });
    const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
    const oneInletModel: CatalogueModel = { ...NO_PSU_MODEL, model: 'ONE-PSU', psuSlots: [{ name: 'PSU0', hotSwap: true, face: 'rear', position: { row: 'single', column: 0 } }] };
    const placed = placeChassis(withRack, rackId, oneInletModel, 1, 'front', { now: NOW });
    const chassisId = edgesIn(placed, rackId, 'MountedIn')[0].from;
    const inletId = edgesOut(placed, chassisId, 'HasPort')
      .map((e) => e.to)
      .find((id) => readPhysicalPortFields(findNode(placed, id)!).connector === 'c14')!;

    const pduPort = formatNodeId('PhysicalPort', newUlid(NOW));
    const withPdu: Document = {
      ...placed,
      nodes: [
        ...placed.nodes,
        {
          id: pduPort,
          existence: newUlid(NOW),
          fields: {
            'PhysicalPort.connector': { presence: 'set', prov: newUlid(NOW), value: 'c13' },
            'PhysicalPort.label': { presence: 'set', prov: newUlid(NOW), value: 'PDU 1' },
          },
        },
      ],
    };
    const fed = connectPorts(withPdu, inletId, pduPort, {}, { now: NOW });
    const view = viewOf(fed, [oneInletModel]);
    const chassisView = view.racks[0].chassis.find((c) => c.id === chassisId)!;
    expect(chassisView.psuInlets).toHaveLength(1);
    expect(chassisView.singleFed).toBe(false);
  });

  it('a chassis with no psu_inlets in the catalogue has an empty psuInlets and is not single-fed', () => {
    const { doc, premisesId } = docWithPremises();
    const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 4, unitNumbering: 'ascending', now: NOW });
    const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
    const placed = placeChassis(withRack, rackId, NO_PSU_MODEL, 1, 'front', { now: NOW });
    const chassisId = edgesIn(placed, rackId, 'MountedIn')[0].from;
    const view = viewOf(placed, [NO_PSU_MODEL]);
    const chassisView = view.racks[0].chassis.find((c) => c.id === chassisId)!;
    expect(chassisView.psuInlets).toHaveLength(0);
    expect(chassisView.singleFed).toBe(false);
  });
});

describe('round trip', () => {
  it('writes a document with cables (inside and outside) to the plain face and reads back equal', () => {
    const { doc, chassisA, chassisB } = twoChassis();
    const insidePort = portByConnector(doc, chassisA, 'rj45');
    const otherInsidePort = portByConnector(doc, chassisB, 'rj45');
    let working = connectPorts(doc, insidePort, otherInsidePort, { sheath: 'purple', label: 'A-B' }, { now: NOW });

    const outsidePort = portByConnector(doc, chassisA, 'lc');
    working = connectToOutside(working, outsidePort, { label: 'Upstream fibre', sheath: 'aqua' }, { now: NOW });

    const bytes = writePlain(working);
    const readBack = readPlain(bytes);
    expect(readBack).toEqual(working);

    // And the view built from the round-tripped document matches too.
    expect(viewOf(readBack, [PORT_MODEL])).toEqual(viewOf(working, [PORT_MODEL]));
  });
});
