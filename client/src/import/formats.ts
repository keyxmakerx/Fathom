// Format readers: NetBox (CSV or JSON), Proxmox (pvesh JSON) and nmap (-oX XML), each reduced to
// a RawTable. Nothing here touches the network or the document.

import { parseDelimited } from './csv';
import { flatten, isObject } from './json';
import { ImportRefusal } from './limits';
import { cleanHeaders, tableOfRecords, type RawTable } from './table';
import { normKey, oneLine } from './text';
import { attr, kid, kids, type XEl } from './xml';

// ---------------------------------------------------------------------------
// CSV and NetBox CSV

const NETBOX_HINTS = new Set([
  'device_type', 'device_role', 'role', 'manufacturer', 'site', 'rack', 'position', 'primary_ip4', 'primary_ip', 'asset_tag',
  'face', 'tenant', 'status', 'platform', 'serial', 'serial_number', 'cluster', 'airflow', 'location', 'type',
]);
const NETBOX_ANCHORS = new Set(['device_type', 'type', 'manufacturer', 'primary_ip4', 'primary_ip', 'site', 'rack', 'position']);

export function looksLikeNetbox(headers: readonly string[]): boolean {
  const keys = new Set(headers.map(normKey));
  if (!keys.has('name')) return false;
  let hints = 0;
  let anchored = false;
  for (const k of keys) {
    if (NETBOX_HINTS.has(k)) hints += 1;
    if (NETBOX_ANCHORS.has(k)) anchored = true;
  }
  return hints >= 3 && anchored;
}

export function delimitedTable(text: string): RawTable {
  const { delimiter, rows, extraCells } = parseDelimited(text);
  if (rows.length < 2) throw new ImportRefusal('There is a header row but no devices under it.');
  const headers = cleanHeaders(rows[0]!);
  const body = rows.slice(1).map((r) => r.slice(0, headers.length));
  const notes: string[] = [];
  if (extraCells > 0) notes.push(`${extraCells} cells beyond the header's width were dropped.`);
  const netbox = looksLikeNetbox(headers);
  const noun = body.length === 1 ? 'row' : 'rows';
  const what = netbox ? 'NetBox device export' : delimiter === '\t' ? 'Tab-separated table' : 'CSV table';
  return { kind: netbox ? 'netbox-csv' : 'csv', label: `${what}, ${body.length} ${noun}`, headers, rows: body, notes };
}

// ---------------------------------------------------------------------------
// JSON

const INTERNAL = /(^|\.)(id|url|display_url|display|slug|created|last_updated|_depth|count|occupied)$/;

function recordsOf(parsed: unknown): Record<string, unknown>[] {
  let list: unknown = parsed;
  if (isObject(parsed)) {
    list = Array.isArray(parsed.results) ? parsed.results : Array.isArray(parsed.data) ? parsed.data : isObject(parsed.data) ? [parsed.data] : [parsed];
  }
  return Array.isArray(list) ? list.filter(isObject) : [];
}

const PVE_RESOURCE = new Set(['qemu', 'lxc', 'node', 'storage', 'sdn', 'pool', 'openvz']);
const PVE_CONFIG_KEYS = ['ostype', 'net0', 'ipconfig0', 'scsi0', 'virtio0', 'rootfs', 'cores', 'sockets', 'bootdisk'];

export function isProxmoxResource(o: Record<string, unknown>): boolean {
  return typeof o.type === 'string' && PVE_RESOURCE.has(o.type) && ('vmid' in o || 'node' in o || 'id' in o);
}
export function isProxmoxConfig(o: Record<string, unknown>): boolean {
  return PVE_CONFIG_KEYS.some((k) => k in o) && ('name' in o || 'hostname' in o || 'memory' in o);
}
function isNetboxRecord(o: Record<string, unknown>): boolean {
  return 'device_type' in o || 'device_role' in o || 'primary_ip4' in o || 'custom_fields' in o || ('role' in o && 'site' in o);
}

export function jsonTable(parsed: unknown): RawTable {
  const items = recordsOf(parsed);
  if (items.length === 0) throw new ImportRefusal('This JSON holds no list of devices.');
  const notes: string[] = [];

  if (items.every((o) => isProxmoxResource(o) || isProxmoxConfig(o))) return proxmoxTable(items, notes);
  const netbox = items.some(isNetboxRecord);
  const records = items.map((o) => flatten(o, netbox ? (p) => INTERNAL.test(p) : () => false));
  const { headers, rows } = tableOfRecords(records, notes);
  const noun = rows.length === 1 ? 'row' : 'rows';
  return {
    kind: netbox ? 'netbox-json' : 'json',
    label: `${netbox ? 'NetBox device export (JSON)' : 'JSON list'}, ${rows.length} ${noun}`,
    headers: cleanHeaders(headers),
    rows,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Proxmox

/** Cloud-init secrets pvesh prints in a guest config; never read into the table at all. */
const PVE_SECRET_KEYS = new Set(['cipassword', 'sshkeys', 'password']);

function firstIp(rec: ReadonlyMap<string, string>): string {
  for (const [k, v] of rec) {
    if (!/^(ipconfig|net)\d+$/.test(k)) continue;
    const m = /(?:^|,)ip=([^,/\s]+)/.exec(v);
    if (m && /^[0-9a-fA-F.:]+$/.test(m[1]!) && m[1]!.includes('.')) return m[1]!;
  }
  return '';
}

function firstMac(rec: ReadonlyMap<string, string>): string {
  for (const [k, v] of rec) {
    if (!/^net\d+$/.test(k)) continue;
    const m = /([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})/.exec(v);
    if (m) return m[1]!.toUpperCase();
  }
  return '';
}

export function proxmoxTable(items: Record<string, unknown>[], notes: string[]): RawTable {
  const records: Array<Map<string, string>> = [];
  let skipped = 0;
  let resources = 0;
  for (const o of items) {
    const isRes = isProxmoxResource(o);
    if (isRes && !['qemu', 'lxc', 'node'].includes(String(o.type))) {
      skipped += 1;
      continue;
    }
    if (isRes) resources += 1;
    const flat = flatten(o);
    for (const k of [...flat.keys()]) if (PVE_SECRET_KEYS.has(k)) flat.delete(k);
    const rec = new Map<string, string>();
    const name = flat.get('name') || flat.get('hostname') || (o.type === 'node' ? flat.get('node') : '') || '';
    rec.set('name', name);
    const ip = firstIp(flat);
    if (ip) rec.set('ip', ip);
    const mac = firstMac(flat);
    if (mac) rec.set('mac', mac);
    for (const [k, v] of flat) {
      if (k === 'name' || k === 'hostname') continue;
      rec.set(k, k === 'tags' ? v.split(';').filter(Boolean).join(', ') : v);
    }
    records.push(rec);
  }
  if (skipped > 0) notes.push(`${skipped} storage, pool and network entries were skipped.`);
  if (records.length === 0) throw new ImportRefusal('This Proxmox file lists no guests or nodes.');
  const { headers, rows } = tableOfRecords(records, notes);
  const what = resources > 0 ? 'Proxmox cluster resources' : 'Proxmox guest configuration';
  return {
    kind: 'proxmox',
    label: `${what}, ${rows.length} ${rows.length === 1 ? 'guest or node' : 'guests and nodes'}`,
    headers: cleanHeaders(headers),
    rows,
    notes,
  };
}

// ---------------------------------------------------------------------------
// nmap

// A script that tries logins or reads defaults can print the credentials it found.
const SCRIPT_REFUSED = /brute|default-accounts|creds|auth|password/i;

function textOf(...parts: string[]): string {
  return parts.map((p) => oneLine(p)).filter(Boolean).join(' ');
}

export function nmapTable(root: XEl): RawTable {
  if (root.tag !== 'nmaprun') throw new ImportRefusal('This XML is not an nmap scan (-oX output).');
  const notes: string[] = [];
  const records: Array<Map<string, string>> = [];
  let down = 0;
  let droppedScripts = 0;
  for (const host of kids(root, 'host')) {
    const state = attr(kid(host, 'status'), 'state');
    if (state !== '' && state !== 'up') {
      down += 1;
      continue;
    }
    const addrs = kids(host, 'address');
    const ip = addrs.find((a) => attr(a, 'addrtype') === 'ipv4') ?? addrs.find((a) => attr(a, 'addrtype') === 'ipv6');
    const mac = addrs.find((a) => attr(a, 'addrtype') === 'mac');
    const hostname = kids(kid(host, 'hostnames') ?? { tag: '', attrs: new Map(), children: [], text: '' }, 'hostname')[0];
    const address = attr(ip, 'addr');
    const rec = new Map<string, string>();
    rec.set('name', oneLine(attr(hostname, 'name')) || address);
    rec.set('address', address);
    if (mac) {
      rec.set('mac', attr(mac, 'addr'));
      rec.set('mac vendor', oneLine(attr(mac, 'vendor')));
    }
    const os = kid(kid(host, 'os') ?? host, 'osmatch');
    if (os) rec.set('os', oneLine(attr(os, 'name')));
    const open: string[] = [];
    const scripts: string[] = [];
    const wanted = (s: XEl) => {
      if (!SCRIPT_REFUSED.test(attr(s, 'id'))) return true;
      droppedScripts += 1;
      return false;
    };
    for (const port of kids(kid(host, 'ports') ?? host, 'port')) {
      if (attr(kid(port, 'state'), 'state') !== 'open') continue;
      const at = `${attr(port, 'portid')}/${attr(port, 'protocol')}`;
      const svc = kid(port, 'service');
      open.push(textOf(at, attr(svc, 'name'), attr(svc, 'product'), attr(svc, 'version'), attr(svc, 'extrainfo')));
      for (const s of kids(port, 'script').filter(wanted)) scripts.push(`${at} ${oneLine(attr(s, 'id'))}: ${attr(s, 'output')}`);
    }
    for (const s of kids(kid(host, 'hostscript') ?? host, 'script').filter(wanted)) scripts.push(`${oneLine(attr(s, 'id'))}: ${attr(s, 'output')}`);
    if (open.length > 0) rec.set('open ports', open.join('; '));
    if (scripts.length > 0) rec.set('scan output', scripts.join('\n'));
    records.push(rec);
  }
  if (droppedScripts > 0) notes.push(`${droppedScripts} script results that could hold logins (brute-force, default-account and credential scripts) were dropped.`);
  if (down > 0) notes.push(`${down} hosts that were not up were skipped.`);
  if (records.length === 0) throw new ImportRefusal('This scan found no hosts that were up.');
  const { headers, rows } = tableOfRecords(records, notes);
  return {
    kind: 'nmap',
    label: `nmap scan, ${rows.length} ${rows.length === 1 ? 'host' : 'hosts'}`,
    headers: cleanHeaders(headers),
    rows,
    notes,
  };
}
