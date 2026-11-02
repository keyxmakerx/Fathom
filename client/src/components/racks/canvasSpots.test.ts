// A device whose rack spot nobody knows is still a whole device: it is drawn on the canvas beside the
// racks, its ports and cables stay, and every menu action that does not need a place is offered.

import { describe, expect, it, vi } from 'vitest';

import type { CatalogueModel } from '../../api/catalogue';
import { connectPorts } from '../../document/cables';
import { createRack, createSketchDevice, placeChassis } from '../../document/commands';
import { pinOf } from '../../document/freeform';
import { edgesIn, edgesOut, emptyDocument, formatNodeId, parseNodeId, type Document } from '../../document/model';
import { newUlid } from '../../document/ulid';
import { undo } from '../../document/undo';
import { viewOf } from '../../document/view';
import { applyEditorChange } from '../design/applyChange';
import { DEVICE_WORDS, deviceMenuItems, type MenuActions } from '../drawing/contextMenuItems';
import { takeOutChange } from '../drawing/editorChanges';
import { U_PX } from '../drawing/geometry';
import { RACK_NODE_WIDTH } from '../drawing/RackNode';
import { closetRightPx } from '../drawing/rows';
import { addThing } from '../inventory/kinds';
import { openCanvasSpots, pinOnCanvas, undrawnDevices } from './canvasSpots';

const NOW = 1_700_000_000_000;
const ACTOR = '00000000000000000000000001';
const OPTS = { actor: ACTOR };

const MODEL: CatalogueModel = {
  vendor: 'arista',
  model: 'TEST-48',
  rackUnits: 1,
  reviewedBy: 'reviewer',
  source: { cite: 'fixture', readOn: '2026-11-02' },
  psuSlots: [],
  faceplates: [{ face: 'front', portCount: 1, ports: [{ kind: 'rj45', number: 0, uplink: false, row: 'single', column: 0, groupGapBefore: false }] }],
};

/** A rack with two boxes cabled together. */
function cabledRack(): { doc: Document; rackId: string; a: string; b: string } {
  const premisesId = formatNodeId('Premises', newUlid(NOW));
  let doc: Document = { ...emptyDocument(), nodes: [{ id: premisesId, existence: newUlid(NOW), fields: { 'Premises.label': { presence: 'set', prov: newUlid(NOW), value: 'P' } } }] };
  doc = createRack(doc, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', now: NOW });
  const rackId = doc.nodes.find((n) => n.id !== premisesId)!.id;
  doc = placeChassis(doc, rackId, MODEL, 1, 'front', { now: NOW });
  const a = edgesIn(doc, rackId, 'MountedIn')[0]!.from;
  doc = placeChassis(doc, rackId, MODEL, 2, 'front', { now: NOW });
  const b = edgesIn(doc, rackId, 'MountedIn').find((e) => e.from !== a)!.from;
  const port = (c: string) => edgesOut(doc, c, 'HasPort')[0]!.to;
  doc = connectPorts(doc, port(a), port(b), { media: 'cat6' }, OPTS);
  return { doc, rackId, a, b };
}

describe('a device with no known rack spot', () => {
  it('is taken out of its rack in one undo step, keeps its ports and cable, and is drawn right of the racks', () => {
    const { doc, a, b } = cabledRack();
    const out = applyEditorChange(doc, takeOutChange(a), [], OPTS).doc;
    expect(out.batches).toHaveLength(doc.batches.length + 1);
    expect(edgesOut(out, a, 'MountedIn').filter((e) => e.absentSince === undefined)).toEqual([]);
    const view = viewOf(out, []);
    expect(view.free.map((f) => f.id)).toEqual([a]);
    expect(pinOf(out, a)!.x).toBeGreaterThan(closetRightPx(view, RACK_NODE_WIDTH, U_PX));
    // Its cable still has both ends: one in the rack, one on the canvas.
    const cable = view.cables.find((c) => c.ends.length === 2)!;
    expect(cable.ends.map((e) => ('chassisId' in e ? e.chassisId : null)).sort()).toEqual([a, b].sort());
    // One undo puts it back in its rack, undrawn.
    const undone = undo(out, out.batches[out.batches.length - 1]!.id, { actor: ACTOR, now: NOW + 5 });
    expect(edgesOut(undone, a, 'MountedIn').filter((e) => e.absentSince === undefined)).toHaveLength(1);
    expect(viewOf(undone, []).free).toEqual([]);
  });

  it('added by name in Inventory, stands on the canvas rather than nowhere', () => {
    const { doc } = cabledRack();
    const made = addThing(doc, 'devices', 'arista-01', null, { catalogue: [], actor: ACTOR, defs: [] });
    const chassisId = made.row.ids!.chassisId!;
    expect(made.doc.batches).toHaveLength(doc.batches.length + 1);
    expect(pinOf(made.doc, chassisId)).not.toBeNull();
    expect(undrawnDevices(viewOf(made.doc, []))).toEqual([]);
  });

  it('pins only devices drawn nowhere, each on its own spot', () => {
    let doc = cabledRack().doc;
    const ids: string[] = [];
    for (const name of ['j1', 'j2', 'j3']) {
      const before = new Set(doc.nodes.map((n) => n.id));
      doc = createSketchDevice(doc, { hostname: name, now: NOW });
      ids.push(doc.nodes.find((n) => !before.has(n.id) && parseNodeId(n.id).kind === 'Chassis')!.id);
    }
    expect(undrawnDevices(viewOf(doc, [])).sort()).toEqual([...ids].sort());
    const racked = cabledRack().a;
    const pinned = pinOnCanvas(doc, [...ids, racked], OPTS);
    const spots = ids.map((id) => pinOf(pinned, id)!);
    expect(new Set(spots.map((p) => `${p.x},${p.y}`)).size).toBe(3);
    expect(pinOnCanvas(pinned, ids, OPTS)).toBe(pinned);
    expect(openCanvasSpots(viewOf(pinned, []), 1)[0]).not.toEqual(spots[0]);
  });

  it("offers a free box the racked device's work: model, firmware, cards and ports; and a racked one Take it out", () => {
    const fn = () => vi.fn();
    const actions: MenuActions = {
      onSelect: fn(),
      onPlanFirmware: fn(),
      onSwapModel: fn(),
      onFitCard: fn(),
      onAddPort: fn(),
      onTakeOut: fn(),
      onOpenInside: fn(),
    };
    const free = deviceMenuItems('c1', actions, { free: true }).map((i) => i.label);
    expect(free).toEqual(expect.arrayContaining([DEVICE_WORDS.planFirmware, DEVICE_WORDS.swapModel, DEVICE_WORDS.fitCard, DEVICE_WORDS.addPort]));
    expect(free).not.toContain(DEVICE_WORDS.takeOut);
    expect(free).not.toContain(DEVICE_WORDS.openInside);
    const racked = deviceMenuItems('c1', actions).find((i) => i.label === DEVICE_WORDS.takeOut)!;
    racked.onSelect();
    expect(actions.onTakeOut).toHaveBeenCalledWith('c1');
  });
});
