// A hover card put away by a press, a key or the wheel stays away until the pointer has left what it was on. The
// listeners themselves are driven in the sample's browser drive; these are the two rules they ask.
import { describe, expect, it } from 'vitest';

import { keyOf, stillOn, type PutAway } from './PortPeek';

const el = (dataset: Record<string, string> = {}) => ({ dataset: dataset as DOMStringMap });

describe('what a hover card is for', () => {
  it('names a thing by its kind and id, whichever of its elements the pointer is on', () => {
    expect(keyOf({ el: el(), kind: 'cable', id: 'c1' })).toBe('cable:c1');
    expect(keyOf({ el: el({ other: 'x' }), kind: 'cable', id: 'c1' })).toBe('cable:c1');
    expect(keyOf({ el: el(), kind: 'device', id: 'c1' })).toBe('device:c1');
  });
  it('names a port by its own id, on a faceplate or inside an opened device', () => {
    expect(keyOf({ el: el({ portId: 'p1' }), kind: 'port' })).toBe('port:p1');
    expect(keyOf({ el: el({ jotPort: 'p2' }), kind: 'port' })).toBe('port:p2');
    expect(keyOf(null)).toBeNull();
  });
});

describe('a hover card put away', () => {
  const inside = {} as Node;
  const outside = {} as Node;
  const away: PutAway = { key: 'device:d1', el: { contains: (n: Node | null) => n === inside } };

  it('stays away on another part of the same thing', () => {
    expect(stillOn(away, 'device:d1', outside)).toBe(true);
  });
  it('and on something drawn inside it, which may still show its own card', () => {
    expect(stillOn(away, 'port:p1', inside)).toBe(true);
  });
  it('until the pointer is on something else, or on nothing', () => {
    expect(stillOn(away, 'device:d2', outside)).toBe(false);
    expect(stillOn(away, null, outside)).toBe(false);
    expect(stillOn(away, null, null)).toBe(false);
  });
  it('and nothing is away when nothing was put away', () => {
    expect(stillOn(null, 'device:d1', inside)).toBe(false);
  });
});
