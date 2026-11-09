// Faceplate templates on the server (migration 0076, sign-off r114): one shared list per
// organisation, each sealed under the organisation content key. Bodies are canonical JSON, as
// every organisation route takes (`fieldDefinitions.ts`'s `body`).

import type { TemplatePort } from '../document/plate';
import { body } from './fieldDefinitions';
import { signedFetch } from './signedFetch';

export interface ServerTemplate {
  id: string;
  name: string;
  role: string | null;
  ports: TemplatePort[];
  createdBy: string;
}

const base = (organisationId: string): string => `/organisations/${encodeURIComponent(organisationId)}/faceplate-templates`;

function parse(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('malformed faceplate-template response: body is not JSON');
  }
}

/** One template as the server sent it. The ports are re-read by the caller's own defensive parser. */
function parseTemplate(raw: unknown): ServerTemplate {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.name !== 'string' || !Array.isArray(o.ports)) {
    throw new Error('malformed faceplate template in the response');
  }
  return {
    id: o.id,
    name: o.name,
    role: typeof o.role === 'string' ? o.role : null,
    ports: o.ports as TemplatePort[],
    createdBy: typeof o.createdBy === 'string' ? o.createdBy : '',
  };
}

export async function fetchTemplates(organisationId: string): Promise<ServerTemplate[]> {
  const list = parse(await signedFetch('GET', base(organisationId)));
  if (!Array.isArray(list)) throw new Error('malformed faceplate-template list');
  return list.map(parseTemplate);
}

/** Saves a template; `replaces` (an id) is removed in the same transaction. */
export async function createTemplate(
  organisationId: string,
  t: { name: string; role: string | null; ports: readonly TemplatePort[]; replaces?: string },
): Promise<ServerTemplate> {
  const sent: Record<string, unknown> = { name: t.name, ports: t.ports };
  if (t.role !== null) sent.role = t.role;
  if (t.replaces !== undefined) sent.replaces = t.replaces;
  return parseTemplate(parse(await signedFetch('POST', base(organisationId), body(sent))));
}

export async function deleteTemplate(organisationId: string, id: string): Promise<void> {
  await signedFetch('DELETE', `${base(organisationId)}/${encodeURIComponent(id)}`);
}
