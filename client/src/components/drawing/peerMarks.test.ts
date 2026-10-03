import { describe, expect, it } from 'vitest';

import { PEER_DOT_PX, peerMarks } from './peerMarks';

const nodes = [
  { id: 'chassis-node:c1', position: { x: 100, y: 50 }, width: 200 },
  { id: 'rack-node:r1', position: { x: 0, y: 0 }, width: 300 },
  { id: 'unmeasured', position: { x: 0, y: 0 } },
];
const who = (account: string, selected: string | null | undefined) => ({ account, initials: account.toUpperCase(), name: account, selected });
const idsFor = (id: string) => [`chassis-node:${id}`, `rack-node:${id}`, id];

describe('peerMarks', () => {
  it('puts a dot at the top right of the first thing each person selected', () => {
    const marks = peerMarks(nodes, [who('a', 'c1')], idsFor);
    expect(marks).toEqual([{ account: 'a', initials: 'A', name: 'a', x: 100 + 200 - PEER_DOT_PX - 2, y: 52 }]);
  });

  it('gives each person one dot, stacked leftwards when they share a thing', () => {
    const marks = peerMarks(nodes, [who('a', 'c1'), who('b', 'c1'), who('c', 'r1')], idsFor);
    expect(marks.map((m) => m.account)).toEqual(['a', 'b', 'c']);
    expect(marks[0].x - marks[1].x).toBe(PEER_DOT_PX + 2);
    expect(marks[2].x).toBe(300 - PEER_DOT_PX - 2);
  });

  it('shows nothing for a person with no selection, or one that is not on the canvas', () => {
    expect(peerMarks(nodes, [who('a', null), who('b', undefined), who('c', 'gone'), who('d', 'unmeasured')], idsFor)).toEqual([]);
  });
});
