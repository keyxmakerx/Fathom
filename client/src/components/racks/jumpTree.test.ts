import { describe, expect, it } from 'vitest';

import { addSketchPort, createRack, createShelf, createSketchDevice, movePlacement, placeOnShelf } from '../../document/commands';
import { emptyDocument, formatNodeId, parseNodeId, type Document } from '../../document/model';
import { newUlid } from '../../document/ulid';
import { viewOf } from '../../document/view';
import { MAX_SHOWN, foldTrail, kindWord, levelsFor, nextFocus, type Level, type TreeInput } from './jumpTree';

const NOW = 1_700_000_000_000;

function scene() {
  const premises = formatNodeId('Premises', newUlid(NOW));
  let doc: Document = {
    ...emptyDocument(),
    nodes: [{ id: premises, existence: newUlid(NOW), fields: { 'Premises.label': { presence: 'set', prov: newUlid(NOW), value: 'T' } } }],
  };
  doc = createRack(doc, premises, { label: 'R1', heightU: 42, unitNumbering: 'ascending', now: NOW });
  const rackId = doc.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Rack')!.id;
  const add = (hostname: string) => {
    let dev = createSketchDevice(emptyDocument(), { now: NOW, hostname });
    const chassisId = dev.nodes.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
    dev = addSketchPort(dev, chassisId, { label: 'Et1', connector: 'rj45', face: 'front' }, { now: NOW });
    const portId = dev.nodes.find((n) => parseNodeId(n.id).kind === 'PhysicalPort')!.id;
    doc = { ...doc, nodes: [...doc.nodes, ...dev.nodes], edges: [...doc.edges, ...dev.edges], provenance: [...doc.provenance, ...dev.provenance], batches: [...doc.batches, ...dev.batches] };
    return { chassisId, portId };
  };
  const sw = add('switch-1');
  doc = movePlacement(doc, sw.chassisId, { kind: 'rack', rackId, positionU: 1, face: 'front' }, { now: NOW });
  const mini = add('mini-pc');
  doc = createShelf(doc, rackId, { label: 'Shelf A', positionU: 10, now: NOW });
  const shelfId = doc.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'PassiveNode')!.id;
  doc = placeOnShelf(doc, mini.chassisId, shelfId, 1, { now: NOW });
  const loose = add('loose-box');
  return { view: viewOf(doc, []), rackId, shelfId, sw, mini, loose };
}

const base = (over: Partial<TreeInput> = {}): TreeInput => ({ designName: 'HQ closet', look: 'rack', selection: null, jotId: null, stop: 'rack', ...over });
const shape = (levels: readonly Level[]) => levels.map((l) => `${l.kind}:${l.name}`);

describe('levelsFor: where you are inside the design', () => {
  it('is just the design when nothing is selected or open', () => {
    const { view } = scene();
    expect(shape(levelsFor(view, base()))).toEqual(['design:HQ closet']);
  });

  it('puts a rack under the design', () => {
    const { view, rackId } = scene();
    expect(shape(levelsFor(view, base({ selection: { kind: 'rack', id: rackId } })))).toEqual(['design:HQ closet', 'rack:R1']);
  });

  it('puts a device in a rack: design, rack, device', () => {
    const { view, sw } = scene();
    const levels = levelsFor(view, base({ selection: { kind: 'chassis', id: sw.chassisId } }));
    expect(shape(levels)).toEqual(['design:HQ closet', 'rack:R1', 'device:switch-1']);
    expect(levels.map((l) => kindWord(l.kind))).toEqual(['DESIGN', 'RACK', 'DEVICE']);
  });

  it('names a close-up of the faceplate or the inside as the deepest level', () => {
    const { view, sw } = scene();
    const sel = { kind: 'chassis', id: sw.chassisId };
    expect(shape(levelsFor(view, base({ selection: sel, stop: 'faceplate' })))).toEqual(['design:HQ closet', 'rack:R1', 'device:switch-1', 'view:Faceplate']);
    expect(shape(levelsFor(view, base({ selection: sel, stop: 'inside' }))).at(-1)).toBe('view:Inside');
    // Zoomed out, the same device has no close-up level.
    expect(shape(levelsFor(view, base({ selection: sel, stop: 'closet' })))).toHaveLength(3);
  });

  it('goes through the shelf for a device on a shelf', () => {
    const { view, mini } = scene();
    expect(shape(levelsFor(view, base({ selection: { kind: 'occupant', id: mini.chassisId } })))).toEqual(['design:HQ closet', 'rack:R1', 'shelf:Shelf A', 'device:mini-pc']);
  });

  it('has no rack for a device on the open canvas', () => {
    const { view, loose } = scene();
    expect(shape(levelsFor(view, base({ selection: { kind: 'chassis', id: loose.chassisId } })))).toEqual(['design:HQ closet', 'device:loose-box']);
  });

  it('ends at the port for a port, through its device and rack', () => {
    const { view, sw } = scene();
    expect(shape(levelsFor(view, base({ selection: { kind: 'port', id: sw.portId } })))).toEqual(['design:HQ closet', 'rack:R1', 'device:switch-1', 'port:Et1']);
  });

  it('shows an opened device as a level of its own, with a port chosen inside it deeper still', () => {
    const { view, sw } = scene();
    expect(shape(levelsFor(view, base({ jotId: sw.chassisId, selection: { kind: 'chassis', id: sw.chassisId } })))).toEqual(['design:HQ closet', 'rack:R1', 'device:switch-1', 'view:Open']);
    expect(shape(levelsFor(view, base({ jotId: sw.chassisId, selection: { kind: 'port', id: sw.portId } })))).toEqual(['design:HQ closet', 'rack:R1', 'device:switch-1', 'view:Open', 'port:Et1']);
  });

  it('invents no site or room: there is no such line', () => {
    const { view, sw } = scene();
    const kinds = levelsFor(view, base({ selection: { kind: 'port', id: sw.portId } })).map((l) => l.kind);
    expect(kinds).not.toContain('site');
    expect(kinds).not.toContain('room');
  });

  it('gives each line a target that goes there, the design clearing the selection', () => {
    const { view, rackId, sw } = scene();
    const levels = levelsFor(view, base({ look: 'diagram', selection: { kind: 'port', id: sw.portId } }));
    expect(levels[0]!.target).toMatchObject({ look: 'diagram', selection: null, jotId: null });
    expect(levels[1]!.target).toMatchObject({ selection: { kind: 'rack', id: rackId }, jotId: null });
    expect(levels[2]!.target).toMatchObject({ selection: { kind: 'chassis', id: sw.chassisId } });
    expect(levels[3]!.target).toMatchObject({ selection: { kind: 'port', id: sw.portId } });
  });

  it('closes an opened device when its line is chosen, and keeps it open for the Open line', () => {
    const { view, sw } = scene();
    const levels = levelsFor(view, base({ jotId: sw.chassisId, selection: { kind: 'port', id: sw.portId } }));
    expect(levels[2]!.target?.jotId).toBeNull();
    expect(levels[3]!.target?.jotId).toBe(sw.chassisId);
  });

  it('falls back to the design alone for a thing that is gone', () => {
    const { view } = scene();
    expect(shape(levelsFor(view, base({ selection: { kind: 'chassis', id: 'Chassis:gone' } })))).toEqual(['design:HQ closet']);
    expect(shape(levelsFor(view, base({ designName: '  ' })))).toEqual(['design:Overview']);
  });
});

const lv = (n: number): Level[] => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, name: `L${i}`, kind: 'device' as const, target: null }));
const text = (lines: ReturnType<typeof foldTrail>) => lines.map((l) => (l.type === 'fold' ? `fold:${l.hidden.length}` : l.level.name));

describe('foldTrail', () => {
  it('shows every level up to six', () => {
    expect(MAX_SHOWN).toBe(6);
    expect(text(foldTrail(lv(1)))).toEqual(['L0']);
    expect(text(foldTrail(lv(6)))).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5']);
  });

  it('past six shows the top two and the last three and folds the middle', () => {
    expect(text(foldTrail(lv(7)))).toEqual(['L0', 'L1', 'fold:2', 'L4', 'L5', 'L6']);
    expect(text(foldTrail(lv(10)))).toEqual(['L0', 'L1', 'fold:5', 'L7', 'L8', 'L9']);
  });

  it('keeps each shown level at its true depth', () => {
    const lines = foldTrail(lv(9));
    const idx = lines.flatMap((l) => (l.type === 'level' ? [l.index] : []));
    expect(idx).toEqual([0, 1, 6, 7, 8]);
  });

  it('shows everything when the fold is expanded, and lists what it hides', () => {
    expect(text(foldTrail(lv(9), true))).toHaveLength(9);
    const fold = foldTrail(lv(9)).find((l) => l.type === 'fold');
    expect(fold?.type === 'fold' && fold.hidden.map((l) => l.name)).toEqual(['L2', 'L3', 'L4', 'L5']);
  });

  it('handles an empty list', () => {
    expect(foldTrail([])).toEqual([]);
  });
});

describe('nextFocus', () => {
  it('moves by arrow, stays within the list, and jumps with Home and End', () => {
    expect(nextFocus(4, 0, 'ArrowDown')).toBe(1);
    expect(nextFocus(4, 3, 'ArrowDown')).toBe(3);
    expect(nextFocus(4, 0, 'ArrowUp')).toBe(0);
    expect(nextFocus(4, 2, 'ArrowUp')).toBe(1);
    expect(nextFocus(4, 2, 'Home')).toBe(0);
    expect(nextFocus(4, 0, 'End')).toBe(3);
    expect(nextFocus(4, 0, 'a')).toBeNull();
    expect(nextFocus(0, 0, 'ArrowDown')).toBeNull();
  });
});
