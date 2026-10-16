import { describe, expect, it } from 'vitest';

import { cableLooseEnds, isLoosePort, portHandleFlags, looseEndText, missingLinkCount, missingLinksOf, splitLooseEnds, type LooseEnd } from './missingLinks';
import { NEEDS_A, NEEDS_B, OUTSIDE, UNKNOWN_A, UNKNOWN_B, WHOLE, missingLinksView } from './missingLinksFixture';

describe('cableLooseEnds', () => {
  it('finds every cable with one end connected and only those', () => {
    const ids = cableLooseEnds(missingLinksView()).map((e) => e.id);
    expect(ids.sort()).toEqual([NEEDS_A, NEEDS_B, UNKNOWN_A, UNKNOWN_B].sort());
    expect(ids).not.toContain(WHOLE);
    expect(ids).not.toContain(OUTSIDE);
  });

  it('names the connected end by device and port, and keeps the cable label when it has one', () => {
    const a = cableLooseEnds(missingLinksView()).find((e) => e.id === NEEDS_A)!;
    expect(a).toMatchObject({ source: 'cable', state: 'needs-finishing', device: 'sw-01', port: '3', portId: 'p1-3', label: 'to patch panel' });
    const b = cableLooseEnds(missingLinksView()).find((e) => e.id === NEEDS_B)!;
    expect(b.label).toBeUndefined();
  });

  it('is Unknown unless a person marked it', () => {
    const states = Object.fromEntries(cableLooseEnds(missingLinksView()).map((e) => [e.id, e.state]));
    expect(states).toEqual({ [NEEDS_A]: 'needs-finishing', [NEEDS_B]: 'needs-finishing', [UNKNOWN_A]: 'unknown', [UNKNOWN_B]: 'unknown' });
  });

  it('ignores a cable whose one end is not on the canvas, and a drawing with no cables', () => {
    const view = missingLinksView();
    const lonely = view.cables.find((c) => c.id === NEEDS_A)!;
    expect(cableLooseEnds({ ...view, cables: [{ ...lonely, ends: [] }] })).toEqual([]);
    expect(cableLooseEnds({ ...view, cables: [] })).toEqual([]);
  });
});

describe('splitLooseEnds and the count', () => {
  it('counts Needs finishing only; Unknown is listed apart and never counted', () => {
    const found = missingLinksOf(missingLinksView());
    expect(found.needsFinishing.map((e) => e.id)).toEqual([NEEDS_A, NEEDS_B]);
    expect(found.unknown.map((e) => e.id)).toEqual([UNKNOWN_A, UNKNOWN_B]);
    expect(missingLinkCount(found)).toBe(2);
  });

  it('is zero (the bar hides the button) when nothing is marked, however many ends are unknown', () => {
    const view = missingLinksView();
    const unmarked = { ...view, cables: view.cables.map((c) => ({ ...c, needsFinishing: false })) };
    const found = missingLinksOf(unmarked);
    expect(missingLinkCount(found)).toBe(0);
    expect(found.unknown).toHaveLength(4);
  });

  it('clears when the cable gets its second end', () => {
    const view = missingLinksView();
    const finished = {
      ...view,
      cables: view.cables.map((c) => (c.id === NEEDS_A ? { ...c, looseEnd: false, needsFinishing: false, ends: [...c.ends, { portId: 'p1-7', chassisId: 'ch-1', rackId: 'rack-1' }] } : c)),
    };
    expect(missingLinkCount(missingLinksOf(finished))).toBe(1);
  });

  it('takes loose ends from anywhere: a circuit joins by handing over its own (always Needs finishing)', () => {
    const circuit: LooseEnd = { source: 'circuit', id: 'circuit-1', state: 'needs-finishing', device: 'edge-01', port: 'ge-0/0/0' };
    const found = splitLooseEnds([...cableLooseEnds(missingLinksView()), circuit]);
    expect(missingLinkCount(found)).toBe(3);
    expect(found.needsFinishing.map((e) => e.source)).toContain('circuit');
  });

  it('orders by device then port, numerically', () => {
    const ends: LooseEnd[] = ['10', '9', '2'].map((port, i) => ({ source: 'cable', id: `c${i}`, state: 'needs-finishing', device: 'sw', port }));
    expect(splitLooseEnds(ends).needsFinishing.map((e) => e.port)).toEqual(['2', '9', '10']);
  });
});

describe('looseEndText', () => {
  it('reads "device port → (no far end)"', () => {
    expect(looseEndText({ source: 'cable', id: 'c', state: 'unknown', device: 'sw-01', port: '3' })).toBe('sw-01 3 → (no far end)');
  });
  it('does not invent a name for an unnamed device', () => {
    expect(looseEndText({ source: 'cable', id: 'c', state: 'unknown', device: '', port: '3' })).toBe('unnamed device 3 → (no far end)');
  });
});

describe('isLoosePort', () => {
  it('is true for a cable with nothing at its other end, false for one to a port, to the outside, or none', () => {
    expect(isLoosePort({ cable: { farPortId: null, outsideCloset: false } })).toBe(true);
    expect(isLoosePort({ cable: { farPortId: 'p', outsideCloset: false } })).toBe(false);
    expect(isLoosePort({ cable: { farPortId: null, outsideCloset: true } })).toBe(false);
    expect(isLoosePort({ cable: null })).toBe(false);
    expect(isLoosePort({})).toBe(false);
  });
});

describe('portHandleFlags', () => {
  it('lets a free port start and end a cable, a cabled one neither, and a one-ended cable end only (to be finished)', () => {
    expect(portHandleFlags(false, false)).toEqual({ isConnectableStart: true, isConnectableEnd: true });
    expect(portHandleFlags(true, false)).toEqual({ isConnectableStart: false, isConnectableEnd: false });
    expect(portHandleFlags(true, true)).toEqual({ isConnectableStart: false, isConnectableEnd: true });
  });
});
