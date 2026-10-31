import { describe, expect, it } from 'vitest';
import { kindNoun } from './kinds';

describe('kindNoun', () => {
  it('says one row in the singular', () => {
    expect(kindNoun('devices', 1)).toBe('device');
    expect(kindNoun('addresses', 1)).toBe('address');
    expect(kindNoun('vlans', 1)).toBe('VLAN');
  });

  it('keeps an acronym in capitals in the plural', () => {
    expect(kindNoun('vlans')).toBe('VLANs');
    expect(kindNoun('devices', 0)).toBe('devices');
    expect(kindNoun('prefixes', 3)).toBe('prefixes');
  });
});
