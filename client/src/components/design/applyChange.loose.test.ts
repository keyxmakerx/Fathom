import { describe, expect, it } from 'vitest';

import { applyEditorChange } from './applyChange';
import { createRack, placeChassis } from '../../document/commands';
import { edgesIn, edgesOut, emptyDocument, formatNodeId, readPhysicalPortFields, findNode, type Document } from '../../document/model';
import { undo } from '../../document/undo';
import { newUlid } from '../../document/ulid';
import { viewOf } from '../../document/view';
import type { CatalogueModel } from '../../api/catalogue';

const NOW = 1_700_000_000_000;
const ACTOR = '00000000000000000000000001';
const OPTS = { actor: ACTOR };

const MODEL: CatalogueModel = {
  vendor: 'test',
  model: 'BOX',
  rackUnits: 1,
  reviewedBy: 'reviewer',
  source: { cite: 'fixture', readOn: '2026-09-16' },
  psuSlots: [],
  faceplates: [{ face: 'front', portCount: 1, ports: [{ kind: 'rj45', number: 0, uplink: false, row: 'single', column: 0, groupGapBefore: false }] }],
};

function twoBoxes(): { doc: Document; a: string; b: string } {
  const premisesId = formatNodeId('Premises', newUlid(NOW));
  let doc: Document = { ...emptyDocument(), nodes: [{ id: premisesId, existence: newUlid(NOW), fields: { 'Premises.label': { presence: 'set', prov: newUlid(NOW), value: 'P' } } }] };
  doc = createRack(doc, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', now: NOW });
  const rackId = doc.nodes.find((n) => n.id !== premisesId)!.id;
  doc = placeChassis(doc, rackId, MODEL, 1, 'front', { now: NOW });
  const first = edgesIn(doc, rackId, 'MountedIn')[0].from;
  doc = placeChassis(doc, rackId, MODEL, 2, 'front', { now: NOW });
  const second = edgesIn(doc, rackId, 'MountedIn').find((e) => e.from !== first)!.from;
  const portOf = (chassis: string) => edgesOut(doc, chassis, 'HasPort').map((e) => e.to).find((id) => readPhysicalPortFields(findNode(doc, id)!).connector === 'rj45')!;
  return { doc, a: portOf(first), b: portOf(second) };
}

describe('the Missing links edits, applied the way the editor applies them', () => {
  it('a cable from a free port with its far end open starts Unknown, then Needs finishing on and off, each one undo step', () => {
    const { doc, a } = twoBoxes();
    const one = applyEditorChange(doc, { kind: 'cable-one-end', portId: a }, [], OPTS).doc;
    const cable = viewOf(one, [MODEL]).cables[0]!;
    expect(cable).toMatchObject({ looseEnd: true, needsFinishing: false });

    const marked = applyEditorChange(one, { kind: 'cable-needs-finishing', id: cable.id, on: true }, [], OPTS).doc;
    expect(viewOf(marked, [MODEL]).cables[0]).toMatchObject({ looseEnd: true, needsFinishing: true });
    const undone = undo(marked, marked.batches[marked.batches.length - 1]!.id, { actor: ACTOR, now: NOW + 5 });
    expect(viewOf(undone, [MODEL]).cables[0]).toMatchObject({ looseEnd: true, needsFinishing: false });

    const cleared = applyEditorChange(marked, { kind: 'cable-needs-finishing', id: cable.id, on: false }, [], OPTS).doc;
    expect(viewOf(cleared, [MODEL]).cables[0]!.needsFinishing).toBe(false);
  });

  it('refuses a second cable on the same port', () => {
    const { doc, a } = twoBoxes();
    const one = applyEditorChange(doc, { kind: 'cable-one-end', portId: a }, [], OPTS).doc;
    expect(() => applyEditorChange(one, { kind: 'cable-one-end', portId: a }, [], OPTS)).toThrow();
  });
});
