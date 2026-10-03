// ADR-0062: organisation-wide custom-field definitions. The server stores each sealed under the
// organisation content key; values stay in the design payload, keyed by definition id. Bodies are
// canonical JSON (sorted keys, no whitespace, one trailing LF) because the server parses strictly.

import { utf8 } from '../crypto/bytes';
import { signedFetch } from './signedFetch';

export const FIELD_FOR = ['device', 'rack', 'cable', 'port', 'network'] as const;
export type FieldFor = (typeof FIELD_FOR)[number];
export const FIELD_TYPES = ['text', 'number', 'date', 'choice', 'url'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface FieldDefView {
  id: string;
  appliesTo: FieldFor;
  name: string;
  type: FieldType;
  choices: readonly string[];
  version: number;
  createdBy: string;
  archived: boolean;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const body = (value: unknown): Uint8Array => utf8(`${canonical(value)}\n`);
const base = (organisationId: string): string => `/organisations/${encodeURIComponent(organisationId)}/field-definitions`;

function parseDef(raw: unknown): FieldDefView {
  const o = raw as Record<string, unknown>;
  const kind = o.kind as FieldFor;
  const type = o.type as FieldType;
  if (
    typeof o.id !== 'string' ||
    typeof o.name !== 'string' ||
    !FIELD_FOR.includes(kind) ||
    !FIELD_TYPES.includes(type) ||
    typeof o.version !== 'number'
  ) {
    throw new Error('malformed field definition in the response');
  }
  return {
    id: o.id,
    appliesTo: kind,
    name: o.name,
    type,
    choices: Array.isArray(o.choices) ? o.choices.filter((c): c is string => typeof c === 'string') : [],
    version: o.version,
    createdBy: typeof o.createdBy === 'string' ? o.createdBy : '',
    archived: o.archived === true,
  };
}

function parse(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('malformed field-definition response: body is not JSON');
  }
}

/** Every definition of the organisation, archived ones included (their values show as removed). */
export async function fetchFieldDefinitions(organisationId: string): Promise<FieldDefView[]> {
  const parsed = parse(await signedFetch('GET', base(organisationId))) as { definitions?: unknown } | unknown[];
  const list = Array.isArray(parsed) ? parsed : (parsed as { definitions?: unknown }).definitions;
  if (!Array.isArray(list)) throw new Error('malformed field-definition list');
  return list.map(parseDef);
}

export async function createFieldDefinition(
  organisationId: string,
  def: { kind: FieldFor; name: string; type: FieldType; choices?: readonly string[] },
): Promise<FieldDefView> {
  return parseDef(parse(await signedFetch('POST', base(organisationId), body(def))));
}

export async function updateFieldDefinition(
  organisationId: string,
  id: string,
  change: { ifVersion: number; name?: string; choices?: readonly string[] },
): Promise<FieldDefView> {
  return parseDef(parse(await signedFetch('PATCH', `${base(organisationId)}/${encodeURIComponent(id)}`, body(change))));
}

export async function archiveFieldDefinition(organisationId: string, id: string, ifVersion: number): Promise<FieldDefView> {
  return parseDef(parse(await signedFetch('POST', `${base(organisationId)}/${encodeURIComponent(id)}/archive`, body({ ifVersion }))));
}
