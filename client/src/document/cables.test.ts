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
import { UnknownReferenceError, addSketchPort, createRack, createShelf, createSurface, fixTo, placeChassis, placeOnShelf } from './commands';
import { FieldValueError } from './edit';
import {
  edgesIn,
  edgesOut,
  emptyDocument,
  findNode,
  formatEdgeId,
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

/** A `Chassis` with one sketch `rj45` port, `HasChassis`'d off a fresh
 * `Device` but placed nowhere yet — `placeChassis`/`createShelf` both write
 * a placement edge as part of creation, but ADR-0051 §1's `placeOnShelf`/
 * `fixTo` take an already-live item and place IT, so the fixture needs one
 * with no placement of its own to hand them. */
function bareChassis(doc: Document): { doc: Document; chassisId: string } {
  const deviceId = formatNodeId('Device', newUlid(NOW));
  const chassisId = formatNodeId('Chassis', newUlid(NOW));
  const withNodes: Document = {
    ...doc,
    nodes: [...doc.nodes, { id: deviceId, existence: newUlid(NOW), fields: {} }, { id: chassisId, existence: newUlid(NOW), fields: {} }],
    edges: [...doc.edges, { id: formatEdgeId('HasChassis', newUlid(NOW)), from: deviceId, to: chassisId, prov: newUlid(NOW), fields: {} }],
  };
  const withPort = addSketchPort(withNodes, chassisId, { label: 'eth0', connector: 'rj45', face: 'front' }, { now: NOW });
  return { doc: withPort, chassisId };
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

  // ADR-0051 §1/§2: the seam `document → viewOf → CableView.ends` has to
  // cross for a shelf occupant's or a surface fixture's own port exactly as
  // it already does for a rack chassis's — neither placement carries a
  // `MountedIn` edge of its own, so `cableEnd` has to walk `placementOf`
  // rather than read `MountedIn` straight off the chassis.
  it('resolves a shelf occupant\'s cable end, rackId from the shelf\'s own rack', () => {
    const { doc, rackId } = rackOf(42);
    const withShelf = createShelf(doc, rackId, { label: 'Shelf', positionU: 20, now: NOW });
    const shelfId = edgesIn(withShelf, rackId, 'MountedIn')[0].from;
    const occ = bareChassis(withShelf);
    const withOccupant = placeOnShelf(occ.doc, occ.chassisId, shelfId, 1, { now: NOW });

    const before = viewOf(withOccupant, [PORT_MODEL]);
    const occupantPortId = before.racks[0].shelves[0].occupants[0].ports[0].id;

    const withChassis = placeChassis(withOccupant, rackId, PORT_MODEL, 1, 'front', { now: NOW });
    const chassisId = edgesIn(withChassis, rackId, 'MountedIn').find((e) => e.from !== shelfId)!.from;
    const chassisPortId = portByConnector(withChassis, chassisId, 'rj45');

    const connected = connectPorts(withChassis, occupantPortId, chassisPortId, {}, { now: NOW });
    const view = viewOf(connected, [PORT_MODEL]);

    expect(view.cables).toHaveLength(1);
    expect(view.cables[0].ends).toHaveLength(2);
    expect(view.cables[0].ends).toContainEqual({ portId: occupantPortId, chassisId: occ.chassisId, rackId });
    expect(view.cables[0].ends).toContainEqual({ portId: chassisPortId, chassisId, rackId });

    const occupantPortView = view.racks[0].shelves[0].occupants[0].ports[0];
    expect(occupantPortView.cable!.outsideCloset).toBe(false);
  });

  it('resolves a surface fixture\'s cable end, rackId null — no rack owns it', () => {
    const { doc, premisesId, rackId } = rackOf(42);
    const withChassis = placeChassis(doc, rackId, PORT_MODEL, 1, 'front', { now: NOW });
    const chassisId = edgesIn(withChassis, rackId, 'MountedIn')[0].from;
    const withSurface = createSurface(withChassis, premisesId, { label: 'West Wall', form: 'wall', now: NOW });
    const surfaceId = edgesOut(withSurface, premisesId, 'HasSurface')[0].to;
    const fixture = bareChassis(withSurface);
    const withFixture = fixTo(fixture.doc, fixture.chassisId, surfaceId, { xMm: 100, yMm: 200 }, { now: NOW });

    const before = viewOf(withFixture, [PORT_MODEL]);
    const fixturePortId = before.surfaces[0].fixtures[0].ports[0].id;
    const chassisPortId = portByConnector(withFixture, chassisId, 'rj45');

    const connected = connectPorts(withFixture, fixturePortId, chassisPortId, {}, { now: NOW });
    const view = viewOf(connected, [PORT_MODEL]);

    expect(view.cables).toHaveLength(1);
    expect(view.cables[0].ends).toHaveLength(2);
    expect(view.cables[0].ends).toContainEqual({ portId: fixturePortId, chassisId: fixture.chassisId, rackId: null });
    expect(view.cables[0].ends).toContainEqual({ portId: chassisPortId, chassisId, rackId });
  });
});

// ADR-0050 §4: both `PORT_MODEL`'s slots are `hotSwap: true`, so their
// inlets live on `PowerSupply` nodes (`FittedIn`), never as `HasPort`
// children of the chassis itself — `supplyInlets` below finds them the way
// `view.ts`'s own `hotSwapInletView` does.
function supplyInlets(doc: Document, chassisId: string): string[] {
  return edgesOut(doc, chassisId, 'FittedIn')
    .filter((e) => e.absentSince === undefined)
    .map((e) => edgesOut(doc, e.to, 'HasPort')[0]?.to)
    .filter((id): id is string => id !== undefined);
}

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
    const inletAId = supplyInlets(doc, chassisA)[0];
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
    const fed = connectPorts(withPdu, inletAId, pduPort, {}, { now: NOW });
    const view = viewOf(fed, [PORT_MODEL]);
    expect(view.racks[0].chassis.find((c) => c.id === chassisA)!.singleFed).toBe(true);
  });

  it('is false with two of two inlets fed', () => {
    const { doc, chassisA } = twoChassis();
    const inlets = supplyInlets(doc, chassisA);
    expect(inlets).toHaveLength(2);
    let working = doc;
    let pduNodes: Array<{ id: string }> = [];
    for (const inletId of inlets) {
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
      working = connectPorts(working, inletId, pduPort, {}, { now: NOW });
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
    const inletId = supplyInlets(placed, chassisId)[0];

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
