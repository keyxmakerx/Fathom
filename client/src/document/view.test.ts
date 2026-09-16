import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../api/catalogue';
import { createRack, placeChassis } from './commands';
import { emptyDocument, formatNodeId, type Document } from './model';
import { newUlid } from './ulid';
import { viewOf } from './view';

const NOW = 1_700_000_000_000;

const MODEL: CatalogueModel = {
  vendor: 'juniper',
  model: 'EX4300-48P',
  rackUnits: 1,
  reviewedBy: 'reviewer',
  source: { cite: 'cite', readOn: '2026-09-14' },
  psuInlets: null,
  faceplates: [
    {
      face: 'front',
      portCount: 2,
      ports: [
        { kind: 'RJ45', number: 0, uplink: false, row: 'top', column: 0, groupGapBefore: false },
        { kind: 'RJ45', number: 1, uplink: false, row: 'bottom', column: 0, groupGapBefore: false },
      ],
    },
    {
      face: 'rear',
      portCount: 1,
      ports: [{ kind: 'QSFP+', number: 0, uplink: true, row: 'single', column: 0, groupGapBefore: false }],
    },
  ],
};

function premisesDoc(): { doc: Document; premisesId: string } {
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

describe('viewOf', () => {
  it('is empty for a document with no Premises', () => {
    expect(viewOf(emptyDocument(), [])).toEqual({ premisesId: '', racks: [] });
  });

  it('draws a rack with no chassis and one free run', () => {
    const { doc, premisesId } = premisesDoc();
    const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 10, unitNumbering: 'ascending', now: NOW });
    const view = viewOf(withRack, []);
    expect(view.premisesId).toBe(premisesId);
    expect(view.racks).toHaveLength(1);
    expect(view.racks[0]).toMatchObject({ label: 'R1', heightU: 10, unitNumbering: 'ascending', chassis: [] });
    expect(view.racks[0].freeRuns).toEqual([{ fromU: 1, toU: 10 }]);
  });

  it('draws a mounted chassis, its catalogue-sourced height and its front-face ports', () => {
    const { doc, premisesId } = premisesDoc();
    const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 10, unitNumbering: 'ascending', now: NOW });
    const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
    const placed = placeChassis(withRack, rackId, MODEL, 3, 'front', { now: NOW });

    const view = viewOf(placed, [MODEL]);
    expect(view.racks[0].chassis).toHaveLength(1);
    const chassis = view.racks[0].chassis[0];
    expect(chassis.model).toBe('EX4300-48P');
    expect(chassis.vendor).toBe('juniper');
    expect(chassis.positionU).toBe(3);
    expect(chassis.heightU).toBe(1);
    expect(chassis.face).toBe('front');
    // Only the front faceplate's two ports are drawn for a front-mounted chassis.
    expect(chassis.ports).toHaveLength(2);
    expect(chassis.ports.map((p) => p.label).sort()).toEqual(['0', '1']);
    expect(chassis.ports.every((p) => p.connector === 'RJ45')).toBe(true);

    expect(view.racks[0].freeRuns).toEqual([
      { fromU: 1, toU: 2 },
      { fromU: 4, toU: 10 },
    ]);
  });

  it('falls back to MountedIn.height_u when the catalogue has no matching model', () => {
    const { doc, premisesId } = premisesDoc();
    const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 10, unitNumbering: 'ascending', now: NOW });
    const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
    const placed = placeChassis(withRack, rackId, MODEL, 3, 'front', { now: NOW });

    const view = viewOf(placed, []); // no catalogue entry supplied
    expect(view.racks[0].chassis[0].heightU).toBe(1); // MountedIn.height_u, set at placement
    expect(view.racks[0].chassis[0].vendor).toBe('');
  });
});
