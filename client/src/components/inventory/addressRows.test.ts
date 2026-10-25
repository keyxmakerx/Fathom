import { describe, expect, it } from 'vitest';

import { deriveNetworks } from '../../document/networks-derive';
import { buildSample, sample } from '../home/sampleNetwork';
import { addressRows } from './kinds';

describe('addressRows', () => {
  it('lists the addresses that sit on VLAN members, so the sample home lab shows all ten', () => {
    const { doc } = buildSample(sample('home-lab'), new Map());
    const d = deriveNetworks(doc);
    const rows = addressRows(doc, d.subnetRows, (id) => id, d.vlanRows);
    expect(rows.map((r) => r.cells.address).sort()).toEqual(
      ['192.168.10.1/24', '192.168.10.10/24', '192.168.10.11/24', '192.168.10.12/24', '192.168.10.5/24', '192.168.10.50/24', '192.168.10.60/24', '192.168.30.1/24', '192.168.30.21/24', '192.168.30.22/24'].sort(),
    );
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});
