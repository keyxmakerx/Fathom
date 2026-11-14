// Steward › IP plan, worked out (ADR-0083 decisions 4 and 7). Pure: the address tree from the
// store's records, nested by containment within one VRF (nothing stores a parent), each block's
// use and its free stretches written as prefixes, the words a row shows, and the store written in
// NetBox's CSV import columns (decision 6). Both families: numbers are BigInt, so an IPv6 /32 and
// an IPv4 /32 go through the same arithmetic.

import type { PlanFields, PlanKind, PlanRecord, PlanValue } from '../../api/ipPlan';

// ---------------------------------------------------------------------------
// Addresses as numbers

export interface Span {
  v6: boolean;
  lo: bigint;
  hi: bigint;
}

const V4_BITS = 32n;
const V6_BITS = 128n;

export function parseIpv4Big(text: string): bigint | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return undefined;
    n = n * 256n + BigInt(Number(p));
  }
  return n;
}

export function parseIpv6Big(text: string): bigint | undefined {
  let t = text.trim().toLowerCase();
  if (t.includes('%')) return undefined;
  // A trailing dotted quad (::ffff:192.0.2.1) is the last two groups.
  const lastColon = t.lastIndexOf(':');
  if (lastColon >= 0 && t.slice(lastColon + 1).includes('.')) {
    const v4 = parseIpv4Big(t.slice(lastColon + 1));
    if (v4 === undefined) return undefined;
    t = `${t.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = t.split('::');
  if (halves.length > 2) return undefined;
  const groups = (s: string) => (s === '' ? [] : s.split(':'));
  const head = groups(halves[0] ?? '');
  const tail = halves.length === 2 ? groups(halves[1] ?? '') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  let n = 0n;
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

export function parseIp(text: string): { v6: boolean; n: bigint } | undefined {
  const t = text.trim();
  if (t.includes(':')) {
    const n = parseIpv6Big(t);
    return n === undefined ? undefined : { v6: true, n };
  }
  const n = parseIpv4Big(t);
  return n === undefined ? undefined : { v6: false, n };
}

export function formatIp(v6: boolean, n: bigint): string {
  if (!v6) return [24n, 16n, 8n, 0n].map((s) => String((n >> s) & 255n)).join('.');
  const groups = [112n, 96n, 80n, 64n, 48n, 32n, 16n, 0n].map((s) => Number((n >> s) & 0xffffn));
  // RFC 5952: the longest run of two or more zero groups becomes "::", the first if tied.
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > bestLen) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

const bitsOf = (v6: boolean) => (v6 ? V6_BITS : V4_BITS);

/** `net/len` as the span it covers; with `host` true the address alone (an interface address). */
export function parseCidrBig(text: string, host = false): (Span & { len: number }) | undefined {
  const [addr, lenText, extra] = text.trim().split('/');
  if (addr === undefined || extra !== undefined) return undefined;
  const ip = parseIp(addr);
  if (ip === undefined) return undefined;
  const bits = bitsOf(ip.v6);
  const len = lenText === undefined ? Number(bits) : /^\d{1,3}$/.test(lenText) ? Number(lenText) : NaN;
  if (!Number.isInteger(len) || len < 0 || BigInt(len) > bits) return undefined;
  if (host) return { v6: ip.v6, lo: ip.n, hi: ip.n, len };
  const size = 1n << (bits - BigInt(len));
  const lo = ip.n - (ip.n % size);
  return { v6: ip.v6, lo, hi: lo + size - 1n, len };
}

export function parseRangeBig(text: string): Span | undefined {
  const [a, b, extra] = text.split('-');
  if (a === undefined || b === undefined || extra !== undefined) return undefined;
  const lo = parseIp(a);
  const hi = parseIp(b);
  if (!lo || !hi || lo.v6 !== hi.v6 || lo.n > hi.n) return undefined;
  return { v6: lo.v6, lo: lo.n, hi: hi.n };
}

export const spanSize = (s: Span): bigint => s.hi - s.lo + 1n;
const contains = (outer: Span, inner: Span) => outer.v6 === inner.v6 && outer.lo <= inner.lo && inner.hi <= outer.hi;

/** The fewest prefixes that exactly cover `lo..hi`, at most `limit` of them; `more` says some were left out. */
export function spanToCidrs(v6: boolean, lo: bigint, hi: bigint, limit: number): { cidrs: string[]; more: boolean } {
  const bits = bitsOf(v6);
  const cidrs: string[] = [];
  let at = lo;
  while (at <= hi) {
    if (cidrs.length === limit) return { cidrs, more: true };
    let size = 1n;
    let len = bits;
    while (len > 0n && at % (size * 2n) === 0n && at + size * 2n - 1n <= hi) {
      size *= 2n;
      len -= 1n;
    }
    cidrs.push(`${formatIp(v6, at)}/${len}`);
    at += size;
  }
  return { cidrs, more: false };
}

function merged(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => (a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0));
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.lo <= last.hi + 1n) {
      if (s.hi > last.hi) last.hi = s.hi;
    } else out.push({ ...s });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading a record

export const text = (f: PlanFields, name: string): string | null => {
  const v = f[name];
  return typeof v === 'string' && v !== '' ? v : null;
};
export const flag = (f: PlanFields, name: string): boolean => f[name] === true;
export const texts = (f: PlanFields, name: string): readonly string[] => {
  const v = f[name];
  return Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
};

/** The space a record in the address tree covers, or undefined for another kind or a value it cannot read. */
export function spanOf(r: PlanRecord): Span | undefined {
  const f = r.fields;
  switch (r.kind) {
    case 'aggregate':
    case 'prefix':
      return parseCidrBig(text(f, 'prefix') ?? '');
    case 'range':
      return parseRangeBig(text(f, 'range') ?? '');
    case 'address':
      return parseCidrBig(text(f, 'address') ?? '', true);
    case 'reservation': {
      const p = text(f, 'prefix');
      if (p) return parseCidrBig(p);
      const g = text(f, 'range');
      if (g) return parseRangeBig(g);
      const a = text(f, 'address');
      return a ? parseCidrBig(a, true) : undefined;
    }
    default:
      return undefined;
  }
}

/** What a reservation holds, as written. */
export const heldValue = (f: PlanFields): string => text(f, 'prefix') ?? text(f, 'range') ?? text(f, 'address') ?? '';

export const ADDRESS_KINDS: readonly PlanKind[] = ['aggregate', 'prefix', 'range', 'reservation', 'address'];
const RANK: Partial<Record<PlanKind, number>> = { aggregate: 0, prefix: 1, range: 2, reservation: 3, address: 4 };
/** A block others nest in: an aggregate, prefix or range, and a reservation of more than one address. */
const holdsOthers = (r: PlanRecord, s: Span) => r.kind === 'aggregate' || r.kind === 'prefix' || r.kind === 'range' || (r.kind === 'reservation' && s.hi > s.lo);
/** A block whose use and free stretches the tree writes out. */
export const isBlock = (k: PlanKind): boolean => k === 'aggregate' || k === 'prefix' || k === 'range';

// ---------------------------------------------------------------------------
// The tree

export interface TreeRow {
  record: PlanRecord;
  span: Span | undefined;
  depth: number;
  parent: string | null;
  /** Ids of the rows directly inside it. */
  children: string[];
  /** Addresses in it taken by what is inside (or all of it when marked utilised or populated). */
  used: bigint;
  size: bigint;
  /** Use as a whole percent, rounded down but never 0 when anything is used. */
  percent: number;
  /** The first few free stretches, as prefixes. Empty for anything but an aggregate or prefix. */
  free: string[];
  freeMore: boolean;
}

/** The VRF a record sits in; an aggregate is always the global table, written ''. */
export const vrfOf = (r: PlanRecord): string => (r.kind === 'aggregate' ? '' : (text(r.fields, 'vrf') ?? ''));

function cmp(a: { r: PlanRecord; s: Span }, b: { r: PlanRecord; s: Span }): number {
  if (a.s.v6 !== b.s.v6) return a.s.v6 ? 1 : -1;
  if (a.s.lo !== b.s.lo) return a.s.lo < b.s.lo ? -1 : 1;
  if (a.s.hi !== b.s.hi) return a.s.hi > b.s.hi ? -1 : 1;
  return (RANK[a.r.kind] ?? 9) - (RANK[b.r.kind] ?? 9);
}

const FREE_SHOWN = 3;

/**
 * The address tree of one VRF (`vrf` '' is the global table): each record under the smallest block
 * that holds it, in address order, IPv4 before IPv6. A record whose value cannot be read is listed
 * last at the top level, not dropped.
 */
export function addressTree(records: readonly PlanRecord[], vrf: string): TreeRow[] {
  const mine = records.filter((r) => ADDRESS_KINDS.includes(r.kind) && vrfOf(r) === vrf);
  const readable: { r: PlanRecord; s: Span }[] = [];
  const unreadable: PlanRecord[] = [];
  for (const r of mine) {
    const s = spanOf(r);
    if (s) readable.push({ r, s });
    else unreadable.push(r);
  }
  readable.sort(cmp);
  const rows = new Map<string, TreeRow>();
  const order: TreeRow[] = [];
  const stack: { r: PlanRecord; s: Span }[] = [];
  for (const item of readable) {
    while (stack.length > 0 && !contains(stack[stack.length - 1].s, item.s)) stack.pop();
    const parent = stack.length > 0 ? stack[stack.length - 1].r.id : null;
    const row: TreeRow = { record: item.r, span: item.s, depth: stack.length, parent, children: [], used: 0n, size: spanSize(item.s), percent: 0, free: [], freeMore: false };
    rows.set(item.r.id, row);
    order.push(row);
    if (parent) rows.get(parent)?.children.push(item.r.id);
    if (holdsOthers(item.r, item.s)) stack.push(item);
  }
  for (const row of order) {
    if (!isBlock(row.record.kind) || !row.span) continue;
    const span = row.span;
    const full = flag(row.record.fields, 'mark_utilised') || flag(row.record.fields, 'populated');
    const inside = merged(row.children.map((id) => rows.get(id)?.span).filter((s): s is Span => s !== undefined));
    row.used = full ? row.size : inside.reduce((n, s) => n + spanSize(s), 0n);
    row.percent = row.used === 0n ? 0 : Math.max(1, Number((row.used * 100n) / row.size));
    if (row.record.kind === 'range' || full) continue;
    let at = span.lo;
    const free: string[] = [];
    let more = false;
    const gaps: [bigint, bigint][] = [];
    for (const s of inside) {
      if (s.lo > at) gaps.push([at, s.lo - 1n]);
      at = s.hi + 1n;
    }
    if (at <= span.hi) gaps.push([at, span.hi]);
    for (const [lo, hi] of gaps) {
      const room = FREE_SHOWN - free.length;
      if (room <= 0) {
        more = true;
        break;
      }
      const part = spanToCidrs(span.v6, lo, hi, room);
      free.push(...part.cidrs);
      if (part.more) more = true;
    }
    row.free = free;
    row.freeMore = more;
  }
  return [
    ...order,
    ...unreadable.map((record) => ({ record, span: undefined, depth: 0, parent: null, children: [], used: 0n, size: 0n, percent: 0, free: [], freeMore: false })),
  ];
}

/** The VRFs that have anything in the address tree, the global table first, by name. */
export function vrfsInUse(records: readonly PlanRecord[]): string[] {
  const ids = new Set(records.filter((r) => ADDRESS_KINDS.includes(r.kind)).map(vrfOf));
  ids.add('');
  const name = (id: string) => nameOfVrf(records, id);
  return [...ids].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : name(a).localeCompare(name(b))));
}

export function nameOfVrf(records: readonly PlanRecord[], id: string): string {
  if (id === '') return 'Global table';
  const vrf = records.find((r) => r.id === id && r.kind === 'vrf');
  return vrf ? (text(vrf.fields, 'name') ?? 'Unnamed VRF') : 'A VRF no longer in the plan';
}

// ---------------------------------------------------------------------------
// Words

export const KIND_WORDS: Record<PlanKind, string> = {
  vrf: 'VRF',
  route_target: 'Route target',
  aggregate: 'Aggregate',
  prefix: 'Prefix',
  range: 'Range',
  address: 'Address',
  reservation: 'Reservation',
  vlan_group: 'VLAN group',
  vlan: 'VLAN',
  asn_range: 'ASN range',
  asn: 'ASN',
};

const cap = (s: string) => (s === '' ? s : s[0].toUpperCase() + s.slice(1));

/** The value a row leads with. */
export function headline(r: PlanRecord): string {
  const f = r.fields;
  switch (r.kind) {
    case 'aggregate':
    case 'prefix':
      return text(f, 'prefix') ?? '';
    case 'range':
      return (text(f, 'range') ?? '').replace('-', ' – ');
    case 'address':
      return text(f, 'address') ?? '';
    case 'reservation':
      return heldValue(f).replace('-', ' – ');
    case 'vrf':
    case 'vlan_group':
    case 'asn_range':
      return text(f, 'name') ?? '';
    case 'route_target':
      return text(f, 'value') ?? '';
    case 'vlan':
      return `${text(f, 'vid') ?? ''} ${text(f, 'name') ?? ''}`.trim();
    case 'asn':
      return text(f, 'asn') ?? '';
  }
}

/** Who holds a reservation, in words: the work, or the person by name. */
export function holderWords(f: PlanFields, names: ReadonlyMap<string, string>, you: string | null): string {
  const work = text(f, 'work');
  if (work) return work;
  const holder = text(f, 'holder');
  if (!holder) return 'nobody named';
  if (holder === you) return 'you';
  return names.get(holder) ?? 'someone no longer here';
}

/** The quiet line under a row's value. */
export function subline(r: PlanRecord, names: ReadonlyMap<string, string>, you: string | null): string {
  const f = r.fields;
  const bits: string[] = [];
  switch (r.kind) {
    case 'aggregate':
      bits.push('Aggregate');
      if (text(f, 'rir')) bits.push(text(f, 'rir') as string);
      break;
    case 'prefix':
      bits.push(cap(text(f, 'status') ?? 'prefix'));
      if (text(f, 'role')) bits.push(text(f, 'role') as string);
      if (flag(f, 'is_pool')) bits.push('pool');
      if (text(f, 'vlan')) bits.push(`VLAN ${text(f, 'vlan')}`);
      break;
    case 'range':
      bits.push(`Range, ${text(f, 'status') ?? ''}`);
      if (text(f, 'role')) bits.push(text(f, 'role') as string);
      if (flag(f, 'populated')) bits.push('populated');
      break;
    case 'address':
      bits.push(`Address, ${text(f, 'status') ?? ''}`);
      if (text(f, 'role')) bits.push(text(f, 'role') as string);
      if (text(f, 'meant_for')) bits.push(`for ${text(f, 'meant_for')}`);
      if (text(f, 'dns_name')) bits.push(text(f, 'dns_name') as string);
      break;
    case 'reservation':
      bits.push(`Reserved for ${holderWords(f, names, you)} until ${text(f, 'ends') ?? '?'}`);
      if (r.lapsed) bits.push('lapsed');
      break;
    default:
      bits.push(KIND_WORDS[r.kind]);
  }
  return bits.filter((b) => b !== '').join(' · ');
}

/** A block's use in words: "2 of 6 usable used" for a small one, a percent for a large one. */
export function usedWords(row: TreeRow): string {
  if (row.size === 0n) return '';
  if (row.size <= 65536n) return `${row.used} of ${row.size} used`;
  return `${row.percent}% used`;
}

/** How a block's usable count is worked out (decision 7: a /29 is 8 addresses, 6 usable). */
export function usableWords(r: PlanRecord): string | null {
  if (r.addresses === null || r.usable === null) return null;
  if (r.addresses === r.usable) {
    return flag(r.fields, 'is_pool') ? `${r.addresses} addresses, all usable: it is a pool` : `${r.addresses} addresses, all usable`;
  }
  return `${r.addresses} addresses, ${r.usable} usable without the network and broadcast addresses`;
}

// ---------------------------------------------------------------------------
// NetBox CSV (decision 6). Columns are the import forms' fields in NetBox 4.7.5,
// netbox/ipam/forms/bulk_import.py on netbox-community/netbox main, read 2026-11-14. A related
// object (VRF, RIR, role, VLAN group, route target) is named, as those forms look it up by name.

function cell(v: string): string {
  return /[",\r\n]/.test(v) || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v;
}
const csv = (head: readonly string[], rows: readonly (readonly string[])[]) => [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
const yes = (b: boolean) => (b ? 'true' : 'false');
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'range';

export interface NetboxFile {
  name: string;
  /** What NetBox calls the list it imports into. */
  netbox: string;
  count: number;
  csv: string;
}

/** The store as NetBox import files, one per kind that has anything, in the order NetBox needs them. */
export function netboxFiles(records: readonly PlanRecord[]): NetboxFile[] {
  const of = (k: PlanKind) => records.filter((r) => r.kind === k);
  const byId = new Map(records.map((r) => [r.id, r]));
  const vrf = (f: PlanFields) => {
    const id = text(f, 'vrf');
    return id ? (text(byId.get(id)?.fields ?? {}, 'name') ?? '') : '';
  };
  const named = (id: string, field: string) => text(byId.get(id)?.fields ?? {}, field) ?? '';
  const t = (f: PlanFields, n: string) => text(f, n) ?? '';
  const reservations = of('reservation');
  const note = (f: PlanFields) => t(f, 'note');
  const reservedNote = (f: PlanFields) => [t(f, 'reason'), t(f, 'work'), t(f, 'ends') ? `until ${t(f, 'ends')}` : ''].filter((s) => s !== '').join(', ');
  const files: NetboxFile[] = [];
  const add = (name: string, netbox: string, head: readonly string[], rows: (readonly string[])[]) => {
    if (rows.length > 0) files.push({ name, netbox, count: rows.length, csv: csv(head, rows) });
  };
  add('route-targets.csv', 'Route targets', ['name', 'description'], of('route_target').map((r) => [t(r.fields, 'value'), note(r.fields)]));
  add(
    'vrfs.csv',
    'VRFs',
    ['name', 'rd', 'enforce_unique', 'import_targets', 'export_targets', 'description'],
    of('vrf').map((r) => [
      t(r.fields, 'name'),
      t(r.fields, 'route_distinguisher'),
      yes(flag(r.fields, 'enforce_unique')),
      texts(r.fields, 'import_targets').map((id) => named(id, 'value')).join(','),
      texts(r.fields, 'export_targets').map((id) => named(id, 'value')).join(','),
      note(r.fields),
    ]),
  );
  add('aggregates.csv', 'Aggregates', ['prefix', 'rir', 'description'], of('aggregate').map((r) => [t(r.fields, 'prefix'), t(r.fields, 'rir'), note(r.fields)]));
  add('vlan-groups.csv', 'VLAN groups', ['name', 'slug', 'vid_ranges', 'description'], of('vlan_group').map((r) => [t(r.fields, 'name'), slug(t(r.fields, 'name')), texts(r.fields, 'vid_ranges').join(','), note(r.fields)]));
  add(
    'vlans.csv',
    'VLANs',
    ['group', 'vid', 'name', 'status', 'description'],
    of('vlan').map((r) => [named(t(r.fields, 'group'), 'name'), t(r.fields, 'vid'), t(r.fields, 'name'), t(r.fields, 'status'), note(r.fields)]),
  );
  add(
    'prefixes.csv',
    'Prefixes',
    ['prefix', 'vrf', 'vlan', 'status', 'role', 'is_pool', 'mark_utilized', 'description'],
    [
      ...of('prefix').map((r) => [t(r.fields, 'prefix'), vrf(r.fields), t(r.fields, 'vlan'), t(r.fields, 'status'), t(r.fields, 'role'), yes(flag(r.fields, 'is_pool')), yes(flag(r.fields, 'mark_utilised')), note(r.fields)]),
      ...reservations.filter((r) => text(r.fields, 'prefix')).map((r) => [t(r.fields, 'prefix'), vrf(r.fields), '', 'reserved', '', 'false', 'false', reservedNote(r.fields)]),
    ],
  );
  const rangeCells = (g: string) => {
    const [a = '', b = ''] = g.split('-');
    return [a, b];
  };
  add(
    'ip-ranges.csv',
    'IP ranges',
    ['start_address', 'end_address', 'vrf', 'status', 'role', 'mark_populated', 'mark_utilized', 'description'],
    [
      ...of('range').map((r) => [...rangeCells(t(r.fields, 'range')), vrf(r.fields), t(r.fields, 'status'), t(r.fields, 'role'), yes(flag(r.fields, 'populated')), yes(flag(r.fields, 'mark_utilised')), note(r.fields)]),
      ...reservations.filter((r) => text(r.fields, 'range')).map((r) => [...rangeCells(t(r.fields, 'range')), vrf(r.fields), 'reserved', '', 'false', 'false', reservedNote(r.fields)]),
    ],
  );
  add(
    'ip-addresses.csv',
    'IP addresses',
    ['address', 'vrf', 'status', 'role', 'dns_name', 'description'],
    [
      ...of('address').map((r) => [t(r.fields, 'address'), vrf(r.fields), t(r.fields, 'status'), t(r.fields, 'role'), t(r.fields, 'dns_name'), [t(r.fields, 'meant_for'), note(r.fields)].filter((s) => s !== '').join(', ')]),
      ...reservations
        .filter((r) => text(r.fields, 'address'))
        .map((r) => {
          const a = t(r.fields, 'address');
          return [a.includes('/') ? a : `${a}/${a.includes(':') ? 128 : 32}`, vrf(r.fields), 'reserved', '', t(r.fields, 'dns_name'), reservedNote(r.fields)];
        }),
    ],
  );
  add('asn-ranges.csv', 'ASN ranges', ['name', 'slug', 'rir', 'start', 'end', 'description'], of('asn_range').map((r) => [t(r.fields, 'name'), slug(t(r.fields, 'name')), t(r.fields, 'rir'), t(r.fields, 'first'), t(r.fields, 'last'), note(r.fields)]));
  add(
    'asns.csv',
    'ASNs',
    ['asn', 'rir', 'description'],
    of('asn').map((r) => [t(r.fields, 'asn'), named(t(r.fields, 'range'), 'rir'), [t(r.fields, 'meant_for'), note(r.fields)].filter((s) => s !== '').join(', ')]),
  );
  return files;
}

/** Whether every value an export needs is there: NetBox refuses an aggregate or ASN with no RIR. */
export function netboxGaps(records: readonly PlanRecord[]): string[] {
  const gaps: string[] = [];
  const byId = new Map(records.map((r) => [r.id, r]));
  const noRir = records.filter((r) => r.kind === 'aggregate' && !text(r.fields, 'rir')).length;
  if (noRir > 0) gaps.push(`${noRir} aggregate${noRir === 1 ? ' has' : 's have'} no RIR, which NetBox needs.`);
  const asnNoRir = records.filter((r) => r.kind === 'asn' && !text(byId.get(text(r.fields, 'range') ?? '')?.fields ?? {}, 'rir')).length;
  if (asnNoRir > 0) gaps.push(`${asnNoRir} ASN${asnNoRir === 1 ? ' has' : 's have'} no RIR from a range, which NetBox needs.`);
  return gaps;
}

export type { PlanValue };
