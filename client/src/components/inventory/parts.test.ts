import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../../api/catalogue';
import { fitCard, setOptic } from '../../document/cards';
import { createRack, placeChassis } from '../../document/commands';
import { edgesIn, edgesOut, emptyDocument, findNode, formatNodeId, readPhysicalPortFields, type Document } from '../../document/model';
import { newUlid } from '../../document/ulid';
import { viewOf } from '../../document/view';
import { applyCellEdits, allColumns, partRows } from './kinds';
import { buildPlaceIndex } from './placeIndex';

const NOW = 1_700_000_000_000;

const MODEL: CatalogueModel = {
  vendor: 'juniper',
  model: 'MX204',
  rackUnits: 1,
  reviewedBy: 'reviewer',
  source: { cite: 'cite', readOn: '2026-09-14' },
  psuSlots: [],
  faceplates: [{ face: 'front', portCount: 1, ports: [{ kind: 'SFP+', number: 0, uplink: false, row: 'single', column: 0, groupGapBefore: false }] }],
};

function estate(): { doc: Document; chassisId: string; portId: string } {
  const premisesId = formatNodeId('Premises', newUlid(NOW));
  const base: Document = {
    ...emptyDocument(),
    nodes: [{ id: premisesId, existence: newUlid(NOW), fields: { 'Premises.label': { presence: 'set', prov: newUlid(NOW), value: 'HQ' } } }],
  };
  const withRack = createRack(base, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', now: NOW });
  const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
  let doc = placeChassis(withRack, rackId, MODEL, 12, 'front', { now: NOW });
  const chassisId = edgesIn(doc, rackId, 'MountedIn')[0].from;
  doc = fitCard(doc, chassisId, '0', { model: 'MPC-10G', serial: 'CARD1', ports: { prefix: 'xe-0/0/', first: 0, last: 1, connector: 'sfp_plus' } });
  const portId = edgesOut(doc, chassisId, 'HasPort').find((e) => readPhysicalPortFields(findNode(doc, e.to)!).label === 'xe-0/0/1')!.to;
  doc = setOptic(doc, portId, { type: '10GBASE-LR', vendor: 'Finisar', part: 'FTLX1471', serial: 'OPT1' });
  return { doc, chassisId, portId };
}

describe('the Parts list', () => {
  it('lists the card and the optic with where they sit and their serials', () => {
    const { doc, chassisId, portId } = estate();
    const view = viewOf(doc, [MODEL]);
    const rows = partRows(doc, view, buildPlaceIndex(doc, view));
    expect(rows.map((r) => [r.cells.kind, r.cells.in, r.cells.serial])).toEqual([
      ['Card', 'slot 0', 'CARD1'],
      ['Optic', 'xe-0/0/1', 'OPT1'],
    ]);
    expect(rows[0]!.selection).toEqual({ kind: 'chassis', id: chassisId });
    expect(rows[1]!.selection).toEqual({ kind: 'port', id: portId });
    expect(rows[1]!.cells.where).toContain('R1');
  });

  it('edits a serial in place, for a card and for an optic', () => {
    const { doc } = estate();
    const view = viewOf(doc, [MODEL]);
    const rows = partRows(doc, view, buildPlaceIndex(doc, view));
    const serial = allColumns('parts', []).find((c) => c.key === 'serial')!;
    const res = applyCellEdits(doc, 'parts', [{ row: rows[0]!, col: serial, value: 'CARD2' }, { row: rows[1]!, col: serial, value: 'OPT2' }], { defs: [], catalogue: [MODEL] });
    expect(res.refused).toEqual([]);
    const after = viewOf(res.doc, [MODEL]);
    const again = partRows(res.doc, after, buildPlaceIndex(res.doc, after));
    expect(again.map((r) => r.cells.serial)).toEqual(['CARD2', 'OPT2']);
    expect(again[1]!.cells.model).toBe('FTLX1471');
  });
});
