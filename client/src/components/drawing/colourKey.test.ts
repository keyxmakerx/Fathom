import { describe, expect, it } from 'vitest';

import { connectPorts } from '../../document/cables';
import { addSketchPort, createRack, createSketchDevice, movePlacement } from '../../document/commands';
import { emptyDocument, formatNodeId, parseNodeId, type Document } from '../../document/model';
import { tagObject } from '../../document/tags';
import { newUlid } from '../../document/ulid';
import { viewOf } from '../../document/view';
import { buildKey, colourKeyRows, vlanWords, type Shareable } from './colourKey';

const set = (...ids: string[]): ReadonlySet<string> => new Set(ids);
const cable = (id: string, sheath: Parameters<typeof buildKey>[0][number]['sheath']) => ({ id, sheath });

describe('buildKey', () => {
  it('names what most of a colour share, in plain words', () => {
    const shareables: Shareable[] = [
      { kind: 'vlan', name: 'Staff VLAN 20', cableIds: set('a', 'b', 'c') },
      { kind: 'tag', name: 'Uplinks', cableIds: set('d', 'e') },
      { kind: 'tag', name: 'Cameras', cableIds: set('f') },
    ];
    const rows = buildKey([cable('a', 'blue'), cable('b', 'blue'), cable('c', 'blue'), cable('d', 'yellow'), cable('e', 'yellow'), cable('f', 'green')], shareables);
    expect(rows.map((r) => r.text)).toEqual(['Blue · Staff VLAN 20', 'Yellow · Uplinks', 'Green · Cameras']);
  });

  it('says how many cables when nothing is shared', () => {
    const rows = buildKey([cable('a', 'red'), cable('b', 'red'), cable('c', 'red'), cable('d', 'red'), cable('e', 'blue')], [{ kind: 'tag', name: 'Odd', cableIds: set('a', 'e') }]);
    const byColour = Object.fromEntries(rows.map((r) => [r.colour, r.text]));
    expect(byColour.Red).toBe('Red · 4 cables');
    expect(byColour.Blue).toBe('Blue · Odd');
  });

  it('needs more than half of the colour, not just some of it', () => {
    const half = buildKey([cable('a', 'blue'), cable('b', 'blue')], [{ kind: 'vlan', name: 'Staff VLAN 20', cableIds: set('a') }]);
    expect(half[0]!.text).toBe('Blue · 2 cables');
    const most = buildKey([cable('a', 'blue'), cable('b', 'blue'), cable('c', 'blue')], [{ kind: 'vlan', name: 'Staff VLAN 20', cableIds: set('a', 'b') }]);
    expect(most[0]!.text).toBe('Blue · Staff VLAN 20');
  });

  it('prefers a VLAN to a tag to a kind of cable when they cover the same cables', () => {
    const same = set('a', 'b');
    const rows = buildKey(
      [cable('a', 'orange'), cable('b', 'orange')],
      [
        { kind: 'type', name: 'Fibre', cableIds: same },
        { kind: 'tag', name: 'Backbone', cableIds: same },
        { kind: 'vlan', name: 'VLAN 10', cableIds: same },
      ],
    );
    expect(rows[0]!.shares).toBe('VLAN 10');
  });

  it('counts a cable with no colour as grey, and says "1 cable" for one', () => {
    const rows = buildKey([cable('a', null)], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sheath: 'grey', colour: 'Grey', count: 1, text: 'Grey · 1 cable' });
  });

  it('lists the colour with most cables first and carries the cable ids for highlighting', () => {
    const rows = buildKey([cable('a', 'red'), cable('b', 'blue'), cable('c', 'blue')], []);
    expect(rows.map((r) => r.colour)).toEqual(['Blue', 'Red']);
    expect([...rows[0]!.cableIds].sort()).toEqual(['b', 'c']);
  });

  it('writes the violet fibre jacket as Violet', () => {
    expect(buildKey([cable('a', 'erika')], [])[0]!.colour).toBe('Violet');
  });
});

describe('vlanWords', () => {
  it('turns the list name round', () => {
    expect(vlanWords('VLAN 20 · Staff')).toBe('Staff VLAN 20');
    expect(vlanWords('VLAN 20')).toBe('VLAN 20');
    expect(vlanWords('Something else')).toBe('Something else');
  });
});

const NOW = 1_700_000_000_000;

function sceneWithTaggedCables(): { doc: Document; cableIds: string[] } {
  const premises = formatNodeId('Premises', newUlid(NOW));
  let doc: Document = {
    ...emptyDocument(),
    nodes: [{ id: premises, existence: newUlid(NOW), fields: { 'Premises.label': { presence: 'set', prov: newUlid(NOW), value: 'T' } } }],
  };
  doc = createRack(doc, premises, { label: 'R1', heightU: 42, unitNumbering: 'ascending', now: NOW });
  const rackId = doc.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Rack')!.id;
  const ports: string[] = [];
  for (let d = 0; d < 2; d += 1) {
    let dev = createSketchDevice(emptyDocument(), { now: NOW, hostname: `dev-${d}` });
    const chassisId = dev.nodes.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
    for (const label of ['e1', 'e2', 'e3']) {
      const before = new Set(dev.nodes.map((n) => n.id));
      dev = addSketchPort(dev, chassisId, { label, connector: 'rj45', face: 'front' }, { now: NOW });
      ports.push(dev.nodes.find((n) => !before.has(n.id) && parseNodeId(n.id).kind === 'PhysicalPort')!.id);
    }
    doc = { ...doc, nodes: [...doc.nodes, ...dev.nodes], edges: [...doc.edges, ...dev.edges], provenance: [...doc.provenance, ...dev.provenance], batches: [...doc.batches, ...dev.batches] };
    doc = movePlacement(doc, chassisId, { kind: 'rack', rackId, positionU: 1 + d, face: 'front' }, { now: NOW });
  }
  // dev-0 e1..e3 -> dev-1 e1..e3 : two blue cables and one yellow
  doc = connectPorts(doc, ports[0]!, ports[3]!, { sheath: 'blue' }, { now: NOW });
  doc = connectPorts(doc, ports[1]!, ports[4]!, { sheath: 'blue' }, { now: NOW });
  doc = connectPorts(doc, ports[2]!, ports[5]!, { sheath: 'yellow' }, { now: NOW });
  const cableIds = doc.nodes.filter((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Cable').map((n) => n.id);
  return { doc, cableIds };
}

describe('colourKeyRows on a real design', () => {
  it('reads tags through the Cables list and counts the rest', () => {
    const { doc: base, cableIds } = sceneWithTaggedCables();
    const view0 = viewOf(base, []);
    const blue = view0.cables.filter((c) => c.sheath === 'blue').map((c) => c.id);
    expect(blue).toHaveLength(2);
    let doc = base;
    for (const id of blue) doc = tagObject(doc, id, 'Uplinks', { now: NOW });
    const rows = colourKeyRows(doc, viewOf(doc, []));
    expect(rows.map((r) => r.text)).toEqual(['Blue · Uplinks', 'Yellow · 1 cable']);
    expect(cableIds).toHaveLength(3);
  });

  it('can only count while the design is still loading', () => {
    const { doc } = sceneWithTaggedCables();
    const rows = colourKeyRows(null, viewOf(doc, []));
    expect(rows.map((r) => r.text)).toEqual(['Blue · 2 cables', 'Yellow · 1 cable']);
  });

  it('is empty for a design with no cables', () => {
    expect(colourKeyRows(emptyDocument(), viewOf(emptyDocument(), []))).toEqual([]);
  });
});
