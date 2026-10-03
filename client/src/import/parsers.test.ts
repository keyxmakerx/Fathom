import { describe, expect, it } from 'vitest';

import { readImport } from './read';
import { fixture, miniXml } from './testkit';

const read = (name: string) => readImport(fixture(name), { xml: miniXml });
const col = (t: { headers: string[]; rows: string[][] }, h: string) => t.rows.map((r) => r[t.headers.indexOf(h)]);

describe('detect and read', () => {
  it('knows a NetBox device CSV and counts its rows', () => {
    const t = read('netbox-devices.csv');
    expect(t.kind).toBe('netbox-csv');
    expect(t.label).toBe('NetBox device export, 8 rows');
    expect(col(t, 'name')[0]).toBe('sw-01');
    expect(t.headers).toContain('cf_owner');
  });

  it('keeps quoted commas and line breaks inside one cell', () => {
    const t = readImport('name,notes\n"a, b","line1\nline2"\nc,"say ""hi"""\n');
    expect(t.kind).toBe('csv');
    expect(t.rows).toEqual([['a, b', 'line1\nline2'], ['c', 'say "hi"']]);
  });

  it('reads tab-separated and semicolon-separated text', () => {
    expect(readImport('name\tip\nsw\t10.0.0.1\n').rows).toEqual([['sw', '10.0.0.1']]);
    expect(readImport('name;ip\nsw;10.0.0.1\n').rows).toEqual([['sw', '10.0.0.1']]);
    expect(readImport('name\tip\nsw\t10.0.0.1\n').label).toBe('Tab-separated table, 1 row');
  });

  it('flattens a NetBox API list and drops its ids and links', () => {
    const t = read('netbox-devices.json');
    expect(t.kind).toBe('netbox-json');
    expect(t.label).toBe('NetBox device export (JSON), 3 rows');
    expect(t.headers).toContain('device_type.model');
    expect(t.headers).toContain('custom_fields.owner');
    expect(t.headers).not.toContain('id');
    expect(t.headers.some((h) => h.endsWith('.url') || h.endsWith('.slug') || h.endsWith('.display'))).toBe(false);
    expect(t.headers).not.toContain('rack');
    expect(t.headers).not.toContain('primary_ip4');
    expect(col(t, 'face')[0]).toBe('front');
    expect(col(t, 'status')[0]).toBe('active');
    expect(col(t, 'tags')[0]).toBe('core, dc1');
    expect(col(t, 'primary_ip4.address')[0]).toBe('10.0.99.2/24');
  });

  it('reads pvesh cluster resources: guests and nodes in, storage out', () => {
    const t = read('pvesh-resources.json');
    expect(t.kind).toBe('proxmox');
    expect(t.label).toBe('Proxmox cluster resources, 4 guests and nodes');
    expect(col(t, 'name')).toEqual(['pve1', 'web-01', 'db-01', 'dns-01']);
    expect(col(t, 'tags')[1]).toBe('prod, web');
    expect(t.notes.join(' ')).toContain('2 storage, pool and network');
  });

  it('reads a qemu config (wrapped in data) and an lxc config; cloud-init secrets never load', () => {
    const q = read('pvesh-qemu-config.json');
    expect(q.kind).toBe('proxmox');
    expect(col(q, 'name')).toEqual(['web-01']);
    expect(col(q, 'ip')).toEqual(['10.0.20.15']);
    expect(col(q, 'mac')).toEqual(['BC:24:11:AA:BB:CC']);
    expect(q.headers).not.toContain('cipassword');
    expect(q.headers).not.toContain('sshkeys');
    expect(JSON.stringify(q)).not.toContain('hunter2');
    const l = read('pvesh-lxc-config.json');
    expect(col(l, 'name')).toEqual(['dns-01']);
    expect(col(l, 'ip')).toEqual(['10.0.20.53']);
  });

  it('reads an nmap scan: up hosts only, open ports, scripts and banners kept', () => {
    const t = read('nmap.xml');
    expect(t.kind).toBe('nmap');
    expect(t.label).toBe('nmap scan, 2 hosts');
    expect(col(t, 'name')).toEqual(['sw-01.hq.example', '10.0.99.50']);
    expect(col(t, 'address')).toEqual(['10.0.99.2', '10.0.99.50']);
    expect(col(t, 'mac vendor')[0]).toBe('Juniper Networks');
    expect(col(t, 'os')[0]).toBe('Juniper JunOS 20.4');
    expect(col(t, 'open ports')[0]).toBe('22/tcp ssh OpenSSH 8.9 protocol 2.0; 80/tcp http nginx');
    expect(col(t, 'scan output')[0]).toContain('80/tcp banner: SNMP community');
    expect(col(t, 'scan output')[0]).toContain('snmp-info: community');
    expect(t.notes.join(' ')).toContain('1 hosts that were not up');
  });

  it('refuses JSON that is not a device list, and empty files', () => {
    expect(() => readImport('{"hello": "world"}')).not.toThrow(); // one record, a JSON list of one row
    expect(() => readImport('[1, 2, 3]')).toThrow(/no list of devices/);
    expect(() => readImport('   \n ')).toThrow(/empty/);
    expect(() => readImport('name\n')).toThrow(/no devices/);
  });
});
