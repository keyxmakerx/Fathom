import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../api/catalogue';
import { connectPorts } from './cables';
import { addSketchPort, createRack, createShelf, createSurface, fixTo, movePlacement, placeChassis, placeOnShelf } from './commands';
import { PlainError, PLAIN_WARNING, readPlain, writePlain } from './plain';
import { edgesIn, edgesOut, emptyDocument, formatEdgeId, formatNodeId, type Document } from './model';
import { removeSupply } from './supplies';
import { newUlid } from './ulid';

// WO-05 §4.4's pinned vector, copied byte for byte from
// `crates/fathom-workspace/tests/plain_face.rs`'s `PINNED` constant — a
// Rust-authored fixture, the cross-language vector this module is proved
// against (see this session's report for why it stands in for
// `client/src/document/vectors/`, which did not exist when this was
// written). `minimal_estate_matches_the_pinned_vector` and
// `worked_example_round_trips_byte_identical` are that file's own proof that
// these bytes are exactly what `write_plain` produces for the graph its
// `minimal_estate()` builds.
const PINNED =
  'fathom-plain 1\n' +
  'THIS FILE IS PLAINTEXT. EVERY PROTECTION THE WORKSPACE HAS ENDS HERE.\n' +
  'schema 0.8\n' +
  '\n' +
  '{"batches":[{"id":"00000000000000000000000002","label":"seed","ops":[{"add_node":{"node":"device:00000000000000000000000001","prov":"00000000000000000000000003"}}]}],"edges":[],"history":[],"nodes":[{"existence":"00000000000000000000000003","fields":{},"id":"device:00000000000000000000000001"}],"provenance":[{"asserted_at":0,"asserted_by":{"user":"00000000000000000000000004"},"confidence":"asserted","id":"00000000000000000000000003","origin":"hand"}]}\n';

function bytesOf(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('readPlain against the Rust-authored PINNED vector', () => {
  it('reads it, and re-writes it byte-identical', () => {
    const doc = readPlain(bytesOf(PINNED));
    const rewritten = writePlain(doc);
    if (new TextDecoder().decode(rewritten) !== PINNED) {
      throw new Error(`byte mismatch\n got: ${toHex(rewritten)}\nwant: ${toHex(bytesOf(PINNED))}`);
    }
    expect(new TextDecoder().decode(rewritten)).toBe(PINNED);
  });

  it('parses the one node, one batch, one provenance record it carries', () => {
    const doc = readPlain(bytesOf(PINNED));
    expect(doc.nodes).toHaveLength(1);
    expect(doc.nodes[0].id).toBe('device:00000000000000000000000001');
    expect(doc.provenance).toHaveLength(1);
    expect(doc.provenance[0].origin).toEqual({ kind: 'hand' });
    expect(doc.batches[0].ops).toEqual([
      { type: 'add_node', node: 'device:00000000000000000000000001', prov: '00000000000000000000000003' },
    ]);
  });
});

describe('writePlain / readPlain own round trip', () => {
  it('round trips the empty document', () => {
    const empty = emptyDocument();
    const bytes = writePlain(empty);
    const reloaded = readPlain(bytes);
    expect(writePlain(reloaded)).toEqual(bytes);
  });

  it('round trips a document with a node of a kind this session does not draw', () => {
    // `Site` — carried through untouched, the walkthrough's own guarantee.
    const doc: Document = {
      ...emptyDocument(),
      nodes: [
        {
          id: 'site:01ARZ3NDEKTSV4RRFFQ69G5FAV',
          existence: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
          fields: {
            'Site.name': { presence: 'set', prov: '01ARZ3NDEKTSV4RRFFQ69G5FAW', value: 'Site A' },
          },
        },
      ],
      provenance: [
        {
          id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
          origin: { kind: 'hand' },
          assertedAt: 1_700_000_000_000,
          assertedBy: '00000000000000000000000000',
          confidence: 'asserted',
        },
      ],
    };
    const bytes = writePlain(doc);
    const reloaded = readPlain(bytes);
    expect(reloaded).toEqual(doc);
    expect(writePlain(reloaded)).toEqual(bytes);
  });

  it('round trips a chassis with one PSU slot fitted and one removed (ADR-0050 §4)', () => {
    const now = 1_700_000_000_000;
    const premisesId = formatNodeId('Premises', newUlid(now));
    const base: Document = {
      ...emptyDocument(),
      nodes: [
        {
          id: premisesId,
          existence: newUlid(now),
          fields: { 'Premises.label': { presence: 'set', prov: newUlid(now), value: 'Riverside CO' } },
        },
      ],
    };
    const model: CatalogueModel = {
      vendor: 'juniper',
      model: 'EX4300-48P',
      rackUnits: 1,
      reviewedBy: 'reviewer',
      source: { cite: 'cite', readOn: '2026-09-14' },
      psuSlots: [
        { name: 'PSU0', hotSwap: true, face: 'rear', position: { row: 'single', column: 0 } },
        { name: 'PSU1', hotSwap: true, face: 'rear', position: { row: 'single', column: 1 } },
      ],
      faceplates: [
        { face: 'front', portCount: 1, ports: [{ kind: 'RJ45', number: 0, uplink: false, row: 'single', column: 0, groupGapBefore: false }] },
      ],
    };
    const withRack = createRack(base, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', now });
    const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
    const placed = placeChassis(withRack, rackId, model, 12, 'front', { now });
    const supplyId = placed.nodes.find((n) => n.id.startsWith('power-supply:'))!.id;
    const doc = removeSupply(placed, supplyId, { now });
    // Sanity: one PowerSupply node is now tombstoned, the other is live.
    expect(doc.nodes.filter((n) => n.id.startsWith('power-supply:'))).toHaveLength(2);
    expect(doc.nodes.find((n) => n.id === supplyId)!.absentSince).toBe(now);

    const bytes = writePlain(doc);
    const reloaded = readPlain(bytes);
    expect(reloaded).toEqual(doc);
    expect(writePlain(reloaded)).toEqual(bytes);
  });
});

describe('a places round trip (ADR-0051 §1, item 8)', () => {
  it('writes and reads back equal: a shelf and two occupants, a wall board carrying an outlet, a floor UPS, a sketched mini PC, and a cable from the sketch to the outlet\'s front', () => {
    const now = 1_700_000_000_000;
    const premisesId = formatNodeId('Premises', newUlid(now));
    let doc: Document = {
      ...emptyDocument(),
      nodes: [
        {
          id: premisesId,
          existence: newUlid(now),
          fields: { 'Premises.label': { presence: 'set', prov: newUlid(now), value: 'Riverside CO' } },
        },
      ],
    };

    doc = createRack(doc, premisesId, { label: 'A-01', heightU: 42, unitNumbering: 'ascending', now });
    const rackId = doc.nodes.find((n) => n.id !== premisesId)!.id;

    // A shelf, U20, and two occupants: a catalogue-sourced desktop switch
    // (placed in the rack, then moved to the shelf — `movePlacement`) and a
    // sketched mini PC (no catalogue model, one port typed by hand).
    doc = createShelf(doc, rackId, { positionU: 20, now });
    const shelfMounted = edgesIn(doc, rackId, 'MountedIn')[0];
    const shelfId = shelfMounted.from;

    const SWITCH: CatalogueModel = {
      vendor: 'ubiquiti',
      model: 'USW-8',
      rackUnits: 1,
      reviewedBy: 'reviewer',
      source: { cite: 'cite', readOn: '2026-09-18' },
      psuSlots: [],
      faceplates: [
        { face: 'front', portCount: 1, ports: [{ kind: 'RJ45', number: 0, uplink: false, row: 'single', column: 0, groupGapBefore: false }] },
      ],
    };
    doc = placeChassis(doc, rackId, SWITCH, 1, 'front', { now });
    const switchChassisId = edgesIn(doc, rackId, 'MountedIn').find((e) => e.id !== shelfMounted.id)!.from;
    doc = movePlacement(doc, switchChassisId, { kind: 'shelf', shelfId, slot: 1 }, { now });

    const sketchDeviceId = formatNodeId('Device', newUlid(now));
    const sketchChassisId = formatNodeId('Chassis', newUlid(now));
    doc = {
      ...doc,
      nodes: [
        ...doc.nodes,
        { id: sketchDeviceId, existence: newUlid(now), fields: {} },
        { id: sketchChassisId, existence: newUlid(now), fields: {} },
      ],
      edges: [
        ...doc.edges,
        { id: formatEdgeId('HasChassis', newUlid(now)), from: sketchDeviceId, to: sketchChassisId, prov: newUlid(now), fields: {} },
      ],
    };
    doc = addSketchPort(doc, sketchChassisId, { label: 'eth0', connector: 'rj45', face: 'front' }, { now });
    doc = placeOnShelf(doc, sketchChassisId, shelfId, 2, { now });

    // A wall, a board fixed to it, and an outlet fixed to the board — a
    // backboard's own occupants measure from the board's edges, not the
    // wall's (`FixedTo`'s own schema doc).
    doc = createSurface(doc, premisesId, { label: 'North wall', form: 'wall', now });
    const wallId = edgesOut(doc, premisesId, 'HasSurface')[0].to;

    const boardId = formatNodeId('PassiveNode', newUlid(now));
    doc = {
      ...doc,
      nodes: [
        ...doc.nodes,
        {
          id: boardId,
          existence: newUlid(now),
          fields: {
            'PassiveNode.form': { presence: 'set', prov: newUlid(now), value: 'board' },
            'PassiveNode.label': { presence: 'set', prov: newUlid(now), value: 'Backboard' },
          },
        },
      ],
    };
    doc = fixTo(doc, boardId, wallId, {}, { now });

    const outletId = formatNodeId('PassiveNode', newUlid(now));
    doc = {
      ...doc,
      nodes: [
        ...doc.nodes,
        {
          id: outletId,
          existence: newUlid(now),
          fields: {
            'PassiveNode.form': { presence: 'set', prov: newUlid(now), value: 'outlet' },
            'PassiveNode.label': { presence: 'set', prov: newUlid(now), value: 'outlet-w1' },
          },
        },
      ],
    };
    doc = fixTo(doc, outletId, boardId, { xMm: 100, yMm: 200 }, { now });

    const outletPortId = formatNodeId('PhysicalPort', newUlid(now));
    doc = {
      ...doc,
      nodes: [
        ...doc.nodes,
        {
          id: outletPortId,
          existence: newUlid(now),
          fields: {
            'PhysicalPort.label': { presence: 'set', prov: newUlid(now), value: '1' },
            'PhysicalPort.connector': { presence: 'set', prov: newUlid(now), value: 'rj45' },
            'PhysicalPort.face': { presence: 'set', prov: newUlid(now), value: 'front' },
          },
        },
      ],
      edges: [
        ...doc.edges,
        { id: formatEdgeId('HasPort', newUlid(now)), from: outletId, to: outletPortId, prov: newUlid(now), fields: {} },
      ],
    };

    // A floor, and a floor-standing UPS — placed in the rack (so
    // `placeChassis` builds its ports/inlets), then moved to the floor.
    doc = createSurface(doc, premisesId, { label: 'Riser closet floor', form: 'floor', now });
    const floorId = edgesOut(doc, premisesId, 'HasSurface').find((e) => e.to !== wallId)!.to;

    const UPS: CatalogueModel = {
      vendor: 'apc',
      model: 'SMT1500',
      rackUnits: 2,
      reviewedBy: 'reviewer',
      source: { cite: 'cite', readOn: '2026-09-18' },
      psuSlots: [],
      faceplates: [
        { face: 'rear', portCount: 1, ports: [{ kind: 'NEMA5-15R', number: 0, uplink: false, row: 'single', column: 0, groupGapBefore: false }] },
      ],
    };
    doc = placeChassis(doc, rackId, UPS, 30, 'front', { now });
    const upsChassisId = edgesIn(doc, rackId, 'MountedIn').find((e) => e.id !== shelfMounted.id)!.from;
    doc = movePlacement(doc, upsChassisId, { kind: 'surface', surfaceId: floorId, xMm: null, yMm: null }, { now });

    // A cable from the sketch's port to the outlet's front.
    const sketchPortId = edgesOut(doc, sketchChassisId, 'HasPort')[0].to;
    doc = connectPorts(doc, sketchPortId, outletPortId, {}, { now });

    const bytes = writePlain(doc);
    const reloaded = readPlain(bytes);
    expect(reloaded).toEqual(doc);
    expect(writePlain(reloaded)).toEqual(bytes);
  });
});

describe('readPlain refusals', () => {
  it('refuses a wrong magic', () => {
    try {
      readPlain(bytesOf('not-fathom-plain 1\n\n\n\n{}\n'));
      throw new Error('expected a refusal');
    } catch (e) {
      expect(e).toBeInstanceOf(PlainError);
      expect((e as PlainError).reason.kind).toBe('not-plain-face');
    }
  });

  it('refuses an unsupported face version', () => {
    const bumped = PINNED.replace('fathom-plain 1', 'fathom-plain 2');
    try {
      readPlain(bytesOf(bumped));
      throw new Error('expected a refusal');
    } catch (e) {
      expect(e).toBeInstanceOf(PlainError);
      expect((e as PlainError).reason).toEqual({ kind: 'unsupported-face-version', found: '2' });
    }
  });

  it('refuses an edited warning line', () => {
    const stripped = PINNED.replace(PLAIN_WARNING, '# nothing to see here');
    try {
      readPlain(bytesOf(stripped));
      throw new Error('expected a refusal');
    } catch (e) {
      expect(e).toBeInstanceOf(PlainError);
      expect((e as PlainError).reason.kind).toBe('missing-plaintext-banner');
    }
  });

  it('refuses a mismatched schema version', () => {
    const bumped = PINNED.replace('schema 0.8', 'schema 0.1');
    try {
      readPlain(bytesOf(bumped));
      throw new Error('expected a refusal');
    } catch (e) {
      expect(e).toBeInstanceOf(PlainError);
      expect((e as PlainError).reason).toEqual({
        kind: 'schema-version-mismatch',
        found: '0.1',
        supported: '0.8',
      });
    }
  });
});
