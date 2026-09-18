import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../api/catalogue';
import { createRack, placeChassis } from './commands';
import { PlainError, PLAIN_WARNING, readPlain, writePlain } from './plain';
import { emptyDocument, formatNodeId, type Document } from './model';
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
