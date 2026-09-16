import { describe, expect, it } from 'vitest';

import { chassisNodeId, parseNodeId, rackNodeId } from './nodeId';

describe('rackNodeId / chassisNodeId / parseNodeId', () => {
  it('round-trips a rack id', () => {
    expect(parseNodeId(rackNodeId('rack-1'))).toEqual({ kind: 'rack', id: 'rack-1' });
  });

  it('round-trips a chassis id', () => {
    expect(parseNodeId(chassisNodeId('chassis-1'))).toEqual({ kind: 'chassis', id: 'chassis-1' });
  });

  it('round-trips an id that itself contains a colon', () => {
    expect(parseNodeId(rackNodeId('site:idf-2'))).toEqual({ kind: 'rack', id: 'site:idf-2' });
  });

  it('returns null for a foreign node id', () => {
    expect(parseNodeId('something-else')).toBeNull();
    expect(parseNodeId('port:port-1')).toBeNull();
    expect(parseNodeId('rack:')).toBeNull();
  });
});
