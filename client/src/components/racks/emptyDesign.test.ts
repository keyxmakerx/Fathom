import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../../api/catalogue';
import { placeChassis } from '../../document/commands';
import { edgesOut, emptyDocument, findNode, readChassisFields, readPremisesFields, readRackFields } from '../../document/model';
import { createPremises, ensureRackToPlaceInto } from './emptyDesign';

const NOW = 1_700_000_000_000;

const MODEL_1U: CatalogueModel = {
  vendor: 'juniper',
  model: 'EX4300-48P',
  rackUnits: 1,
  reviewedBy: 'reviewer',
  source: { cite: 'cite', readOn: '2026-09-14' },
  psuInlets: { kind: 'C14', count: 2 },
  faceplates: [{ face: 'front', portCount: 0, ports: [] }],
};

describe('createPremises', () => {
  it('creates one live Premises node with a label', () => {
    const { doc, premisesId } = createPremises(emptyDocument(), { now: NOW });
    expect(doc.nodes).toHaveLength(1);
    const node = findNode(doc, premisesId);
    expect(node).toBeDefined();
    expect(node!.absentSince).toBeUndefined();
    expect(readPremisesFields(node!).label).toBe('Premises');
    expect(doc.batches).toHaveLength(1);
  });

  it('does not mutate its input', () => {
    const doc = emptyDocument();
    const before = JSON.stringify(doc);
    createPremises(doc, { now: NOW });
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('ensureRackToPlaceInto — the "first placement creates the premises and rack" rule', () => {
  it('mints a Premises and a Rack when the document has neither', () => {
    const { doc, premisesId, rackId } = ensureRackToPlaceInto(emptyDocument(), null, { now: NOW });

    const premises = findNode(doc, premisesId);
    expect(premises).toBeDefined();
    expect(premises!.absentSince).toBeUndefined();

    const rack = findNode(doc, rackId);
    expect(rack).toBeDefined();
    expect(readRackFields(rack!)).toEqual({ label: 'Rack 1', heightU: 42, unitNumbering: 'ascending' });

    const hasRack = edgesOut(doc, premisesId, 'HasRack');
    expect(hasRack).toHaveLength(1);
    expect(hasRack[0].to).toBe(rackId);
  });

  it('reuses an existing Premises rather than minting a second one', () => {
    const { doc: withPremises, premisesId } = createPremises(emptyDocument(), { now: NOW });
    const { doc, rackId } = ensureRackToPlaceInto(withPremises, premisesId, { now: NOW });

    expect(doc.nodes.filter((n) => n.id === premisesId)).toHaveLength(1);
    const hasRack = edgesOut(doc, premisesId, 'HasRack');
    expect(hasRack).toHaveLength(1);
    expect(hasRack[0].to).toBe(rackId);
  });

  it('gives placeChassis a rack it can actually mount into', () => {
    const { doc, rackId } = ensureRackToPlaceInto(emptyDocument(), null, { now: NOW });
    const next = placeChassis(doc, rackId, MODEL_1U, 1, 'front', { now: NOW });

    const allChassis = next.nodes.filter((n) => n.id.startsWith('chassis:'));
    expect(allChassis).toHaveLength(1);
    expect(readChassisFields(allChassis[0]).model).toBe('EX4300-48P');
  });

  it('does not mutate its input document', () => {
    const doc = emptyDocument();
    const before = JSON.stringify(doc);
    ensureRackToPlaceInto(doc, null, { now: NOW });
    expect(JSON.stringify(doc)).toBe(before);
  });
});
