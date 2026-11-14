// Steward › IP plan (ADR-0083). Wire shapes are `crates/fathom-server/src/design_api/ipam_routes.rs`:
// every route is a signed POST under `/organisations/{o}/ipam/`, and a refusal is `{"error": text}`,
// a sentence the page shows as it is. Field values travel as the schema's canonical text (an
// address, a VLAN ID and an ASN are all strings), with `true`/`false` for the flags.

import { body } from './fieldDefinitions';
import { ApiRefusal } from './errors';
import { arrayOf, asRec, int, jsonObject, str, type Rec } from './json';
import { signedFetch } from './signedFetch';

/** The store's eleven kinds, by their wire token (`ipam::Kind::token`). */
export const PLAN_KINDS = [
  'vrf',
  'route_target',
  'aggregate',
  'prefix',
  'range',
  'address',
  'reservation',
  'vlan_group',
  'vlan',
  'asn_range',
  'asn',
] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];

/** A field's value as stored: canonical text, a flag, or a list of texts. */
export type PlanValue = string | boolean | readonly string[];
export type PlanFields = Readonly<Record<string, PlanValue>>;

export interface PlanRecord {
  id: string;
  kind: PlanKind;
  version: number;
  fields: PlanFields;
  /** A reservation past its end: still held, marked (decision 3). */
  lapsed: boolean;
  /** A block's address count and usable count, as decimal text (an IPv6 /48 does not fit a number). */
  addresses: string | null;
  usable: string | null;
}

export interface PlanList {
  records: PlanRecord[];
  /** The server's date, so "lapsed" and "ends" read against the same day. */
  today: string;
}

const base = (organisation: string) => `/organisations/${encodeURIComponent(organisation)}/ipam`;

function fieldsOf(value: unknown): PlanFields {
  const rec = asRec(value, 'ip plan record fields');
  const out: Record<string, PlanValue> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === 'string' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = v as string[];
  }
  return out;
}

export function parseRecord(value: unknown): PlanRecord {
  const r: Rec = asRec(value, 'ip plan record');
  const kind = str(r, 'kind', 'ip plan record');
  if (!(PLAN_KINDS as readonly string[]).includes(kind)) throw new Error('malformed ip plan record response: bad kind');
  return {
    id: str(r, 'id', 'ip plan record'),
    kind: kind as PlanKind,
    version: int(r, 'version', 'ip plan record'),
    fields: fieldsOf(r.fields),
    lapsed: r.lapsed === true,
    addresses: typeof r.addresses === 'string' ? r.addresses : null,
    usable: typeof r.usable === 'string' ? r.usable : null,
  };
}

export function parseList(bytes: Uint8Array): PlanList {
  const r = jsonObject(bytes, 'ip plan');
  return { records: arrayOf(r, 'records', 'ip plan').map(parseRecord), today: str(r, 'today', 'ip plan') };
}

/** The store's sentence from a refusal, when it gave one; else null. */
export function planRefusal(error: unknown): string | null {
  if (!(error instanceof ApiRefusal)) return null;
  try {
    const parsed: unknown = JSON.parse(error.message);
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as Rec).error === 'string') return (parsed as Rec).error as string;
  } catch {
    // not the store's JSON
  }
  return null;
}

/** Drop what was left empty, so an optional field is absent rather than "". */
export function cleanFields(fields: Readonly<Record<string, PlanValue | null | undefined>>): Record<string, PlanValue> {
  const out: Record<string, PlanValue> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') {
      if (v.trim() !== '') out[k] = v.trim();
    } else if (typeof v === 'boolean') {
      out[k] = v;
    } else {
      const list = v.map((x) => x.trim()).filter((x) => x !== '');
      if (list.length > 0) out[k] = list;
    }
  }
  return out;
}

export async function fetchPlan(organisation: string): Promise<PlanList> {
  return parseList(await signedFetch('POST', `${base(organisation)}/list`, body({})));
}

export async function createRecord(organisation: string, kind: PlanKind, fields: PlanFields): Promise<PlanRecord> {
  const r = jsonObject(await signedFetch('POST', `${base(organisation)}/create`, body({ kind, fields })), 'ip plan create');
  return parseRecord(r.record);
}

export async function updateRecord(organisation: string, id: string, version: number, fields: PlanFields): Promise<PlanRecord> {
  const r = jsonObject(await signedFetch('POST', `${base(organisation)}/update`, body({ id, version, fields })), 'ip plan update');
  return parseRecord(r.record);
}

export async function deleteRecord(organisation: string, id: string): Promise<void> {
  await signedFetch('POST', `${base(organisation)}/delete`, body({ id }));
}

/** What next free is asked for. `length` for a prefix; `name` for a VLAN (needed to take one). */
export type Want = { want: 'prefix'; length: number } | { want: 'address' } | { want: 'vlan'; name: string } | { want: 'asn' };

function wantBody(w: Want): Record<string, unknown> {
  if (w.want === 'prefix') return { want: 'prefix', length: w.length };
  if (w.want === 'vlan') return w.name.trim() === '' ? { want: 'vlan' } : { want: 'vlan', name: w.name.trim() };
  return { want: w.want };
}

/** Look only: the next free thing in `parent`, or the store's sentence why there is none. */
export async function lookNext(organisation: string, parent: string, want: Want): Promise<string> {
  const r = jsonObject(await signedFetch('POST', `${base(organisation)}/next`, body({ parent, ...wantBody(want), take: false })), 'ip plan next');
  return str(r, 'free', 'ip plan next');
}

/** Hand it out under `key`. `again` is true when the same key was answered before. */
export async function takeNext(
  organisation: string,
  parent: string,
  want: Want,
  key: string,
  hold: PlanFields,
): Promise<{ record: PlanRecord; again: boolean }> {
  const payload: Record<string, unknown> = { parent, ...wantBody(want), take: true, key: key.trim() };
  if (Object.keys(hold).length > 0) payload.hold = hold;
  const r = jsonObject(await signedFetch('POST', `${base(organisation)}/next`, body(payload)), 'ip plan next');
  return { record: parseRecord(r.record), again: r.again === true };
}
