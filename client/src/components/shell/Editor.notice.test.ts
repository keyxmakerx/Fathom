import { describe, expect, it } from 'vitest';

import { matchLabel, panelHolds } from './Editor';

describe('where a live notice sits in the editor', () => {
  it('matches a field row by its panel label', () => {
    expect(matchLabel('serial', 'serial')).toBe(true);
    expect(matchLabel('mgmt address', 'mgmt address')).toBe(true);
    expect(matchLabel('height (u)', 'height')).toBe(true);
    expect(matchLabel('length (m)', 'length')).toBe(true);
    expect(matchLabel('sheath — the lead you actually used', 'sheath')).toBe(true);
    expect(matchLabel('serial number', 'serial')).toBe(true);
    expect(matchLabel('ports', 'port')).toBe(false);
  });

  it('only anchors on a panel that holds the overwritten element', () => {
    expect(panelHolds('chassis-1 device-1', 'device-1')).toBe(true);
    expect(panelHolds('chassis-1 device-1', 'device-2')).toBe(false);
    expect(panelHolds(undefined, 'device-1')).toBe(false);
    expect(panelHolds('chassis-10', 'chassis-1')).toBe(false);
  });
});
