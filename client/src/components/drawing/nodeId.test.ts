import { describe, expect, it } from 'vitest';

import { chassisNodeId, parseNodeId, rackNodeId, rowLabelNodeId, trayNodeId } from './nodeId';

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

  it('a tray node id is never a Selection this drawing raises — deliberately not parsed', () => {
    expect(parseNodeId(trayNodeId('rack-1|above|up the riser'))).toBeNull();
  });

  it('a row label node id is never a Selection this drawing raises — deliberately not parsed', () => {
    expect(parseNodeId(rowLabelNodeId('A'))).toBeNull();
  });
});
