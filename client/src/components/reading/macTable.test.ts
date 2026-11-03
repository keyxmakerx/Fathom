import { describe, expect, it } from 'vitest';

import { asCsv, macRows, matches } from './macTable';

const reading = {
  interfaces: [
    { index: 7, name: 'Gi1/0/7' },
    { index: 19, name: 'Gi1/0/19' },
  ],
  mac: [
    { mac: '3c:22:fb:7e:02:9c', fdbId: 20, bridgePort: 19, ifIndex: 19, status: 'learned' },
    { mac: '3C:22:FB:10:AA:01', fdbId: 20, bridgePort: 7, ifIndex: 7, status: 'learned' },
    { mac: '00:00:5e:00:01:01', fdbId: 1, bridgePort: null, ifIndex: null, status: 'self' },
  ],
  arp: [
    { ifIndex: 100, ip: '10.20.20.41', mac: '3c:22:fb:10:aa:01', type: 'dynamic' },
    { ifIndex: 100, ip: '10.20.20.99', mac: '3c:22:fb:7e:02:9c', type: 'invalid' },
  ],
};

describe('device reading: MAC and ARP', () => {
  it('names each port, joins the address from ARP, and leaves out the switch itself', () => {
    const { rows, arp } = macRows(reading);
    expect(arp).toBe(1);
    expect(rows).toEqual([
      { port: 'Gi1/0/7', mac: '3c:22:fb:10:aa:01', vlan: 20, ip: '10.20.20.41' },
      { port: 'Gi1/0/19', mac: '3c:22:fb:7e:02:9c', vlan: 20, ip: '' },
    ]);
  });

  it('finds a MAC however it was typed', () => {
    const [row] = macRows(reading).rows;
    expect(matches(row!, '3C-22-FB-10')).toBe(true);
    expect(matches(row!, '3c22.fb10')).toBe(true);
    expect(matches(row!, '10.20.20.4')).toBe(true);
    expect(matches(row!, 'gi1/0/7')).toBe(true);
    expect(matches(row!, 'gi1/0/1')).toBe(false);
    expect(matches(row!, '')).toBe(false);
  });

  it('writes CSV a spreadsheet will not run', () => {
    expect(asCsv([{ port: '=cmd()', mac: 'aa', vlan: null, ip: '1.1.1.1, 2.2.2.2' }])).toBe(`Port,MAC,VLAN,IP\n'=cmd(),aa,,"1.1.1.1, 2.2.2.2"\n`);
  });
});
