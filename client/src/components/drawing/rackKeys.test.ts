import { describe, expect, it, vi } from 'vitest';

import { nudgePlan, rackDeviceKey, selectedRackId, type RackKeyContext } from './rackKeys';

const rack = { id: 'rack:1', heightU: 10, chassis: [{ id: 'chassis:a', positionU: 3, heightU: 1 }, { id: 'chassis:b', positionU: 4, heightU: 2 }] };

function key(k: string, extra: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: null, preventDefault: vi.fn(), ...extra } as unknown as KeyboardEvent;
}

function ctx(over: Partial<RackKeyContext> = {}): RackKeyContext {
  return { racks: [rack], selected: { kind: 'chassis', id: 'chassis:a' }, canDraw: true, clipboard: { current: null }, shake: vi.fn(), onMove: vi.fn(), onDuplicate: vi.fn(), onPaste: vi.fn(), ...over };
}

describe('nudgePlan', () => {
  it('moves a unit down into free space', () => {
    expect(nudgePlan([rack], 'chassis:a', -1)).toEqual({ kind: 'move', rackId: 'rack:1', positionU: 2 });
  });
  it('refuses to overlap a neighbour', () => {
    expect(nudgePlan([rack], 'chassis:a', 1)).toEqual({ kind: 'blocked', rackId: 'rack:1' });
  });
  it('refuses to leave the rack', () => {
    const edge = { ...rack, chassis: [{ id: 'chassis:a', positionU: 1, heightU: 1 }] };
    expect(nudgePlan([edge], 'chassis:a', -1)).toEqual({ kind: 'blocked', rackId: 'rack:1' });
  });
  it('knows nothing of a device that is not in a rack', () => {
    expect(nudgePlan([rack], 'chassis:zzz', 1)).toBeNull();
  });
});

describe('rackDeviceKey', () => {
  // The typing guard reads the document; a bare node environment has none.
  (globalThis as { document?: unknown }).document = { activeElement: null };

  it('moves the device with the arrows, and shakes when it cannot', () => {
    const c = ctx();
    expect(rackDeviceKey(key('ArrowDown'), c)).toBe(true);
    expect(c.onMove).toHaveBeenCalledWith('chassis:a', 'rack:1', 2);
    expect(rackDeviceKey(key('ArrowUp'), c)).toBe(true);
    expect(c.shake).toHaveBeenCalledWith('rack:1');
  });

  it('duplicates with Ctrl+D', () => {
    const c = ctx();
    expect(rackDeviceKey(key('d', { ctrlKey: true }), c)).toBe(true);
    expect(c.onDuplicate).toHaveBeenCalledWith('chassis:a');
  });

  it('copies, then pastes into the selected rack', () => {
    const c = ctx();
    rackDeviceKey(key('c', { ctrlKey: true }), c);
    const into = { ...c, selected: { kind: 'rack' as const, id: 'rack:1' } };
    expect(rackDeviceKey(key('v', { ctrlKey: true }), into)).toBe(true);
    expect(c.onPaste).toHaveBeenCalledWith('chassis:a', 'rack:1');
  });

  it('copying something that is not a rack device clears what a paste would use', () => {
    const c = ctx();
    rackDeviceKey(key('c', { ctrlKey: true }), c);
    rackDeviceKey(key('c', { ctrlKey: true }), { ...c, selected: { kind: 'cable', id: 'cable:1' } });
    expect(rackDeviceKey(key('v', { ctrlKey: true }), c)).toBe(false);
  });

  it('does nothing while typing, for a reader, or with nothing selected', () => {
    expect(rackDeviceKey(key('ArrowUp', { target: { tagName: 'INPUT' } as unknown as EventTarget }), ctx())).toBe(false);
    expect(rackDeviceKey(key('ArrowUp'), ctx({ canDraw: false }))).toBe(false);
    expect(rackDeviceKey(key('ArrowUp'), ctx({ selected: null }))).toBe(false);
  });
});

describe('selectedRackId', () => {
  it('is the selected rack or the rack of the selected device', () => {
    expect(selectedRackId([rack], { kind: 'rack', id: 'rack:1' })).toBe('rack:1');
    expect(selectedRackId([rack], { kind: 'chassis', id: 'chassis:b' })).toBe('rack:1');
    expect(selectedRackId([rack], { kind: 'cable', id: 'x' })).toBeNull();
  });
});
