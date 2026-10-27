// The estate index (ADR-0079): search and Inventory across every design this person may read.
// `crates/fathom-server/src/design_api/estate_routes.rs`. POST with a canonical JSON body, because
// the query is free text.

import { body } from './fieldDefinitions';
import { signedFetch } from './signedFetch';

export type EstateKind = 'device' | 'card' | 'optic' | 'power_supply' | 'spare';

export interface EstateHit {
  design: string;
  /** The design's name, or null when it has none. */
  designName: string | null;
  element: string;
  /** What opening the row shows: a chassis, a port or a store. */
  open: string;
  kind: EstateKind;
  name: string;
  model: string;
  serial: string;
  /** The device it belongs to; empty for a device or a spare. */
  device: string;
  /** Rack and U, or store and bin. */
  place: string;
  addresses: string[];
  /** A device's ports, for picking the far end of a link between sites. */
  ports: EstatePort[];
}

export interface EstatePort {
  id: string;
  name: string;
  /** Where this port's own link to another site lands, when it has one. */
  far?: { design: string; element: string };
}

export interface EstateAnswer {
  hits: EstateHit[];
  /** How many designs were looked in. */
  designs: number;
  /** How many of them are still being brought up to date. */
  behind: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function parsePort(v: unknown): EstatePort {
  const o = (v ?? {}) as Record<string, unknown>;
  const port: EstatePort = { id: str(o.id), name: str(o.name) };
  const design = str(o.farDesign);
  const element = str(o.farElement);
  if (design !== '' && element !== '') port.far = { design, element };
  return port;
}

export function parseEstate(bytes: Uint8Array): EstateAnswer {
  const raw = JSON.parse(new TextDecoder().decode(bytes)) as { hits?: unknown[]; designs?: unknown; behind?: unknown };
  const hits = (raw.hits ?? []).map((h): EstateHit => {
    const o = (h ?? {}) as Record<string, unknown>;
    return {
      design: str(o.design),
      designName: typeof o.designName === 'string' ? o.designName : null,
      element: str(o.element),
      open: str(o.open) || str(o.element),
      kind: str(o.kind) as EstateKind,
      name: str(o.name),
      model: str(o.model),
      serial: str(o.serial),
      device: str(o.device),
      place: str(o.place),
      addresses: Array.isArray(o.addresses) ? o.addresses.map(str).filter(Boolean) : [],
      ports: Array.isArray(o.ports) ? o.ports.map(parsePort).filter((p) => p.id !== '') : [],
    };
  });
  return { hits, designs: Number(raw.designs ?? 0), behind: Number(raw.behind ?? 0) };
}

export async function searchEstate(organisationId: string, q: string, kind?: EstateKind): Promise<EstateAnswer> {
  const path = `/organisations/${encodeURIComponent(organisationId)}/estate/search`;
  return parseEstate(await signedFetch('POST', path, body(kind ? { q, kind } : { q })));
}

export async function pageEstate(organisationId: string, kind?: EstateKind, after?: [string, string]): Promise<EstateAnswer> {
  const path = `/organisations/${encodeURIComponent(organisationId)}/estate/page`;
  const req: Record<string, unknown> = {};
  if (kind) req.kind = kind;
  if (after) req.after = after;
  return parseEstate(await signedFetch('POST', path, body(req)));
}

/** "Device", "Optic"…: the kind as a person says it. */
export const ESTATE_KIND_WORD: Record<EstateKind, string> = {
  device: 'Device',
  card: 'Card',
  optic: 'Optic',
  power_supply: 'Power supply',
  spare: 'Spare',
};

/** Ask the app to open a thing in another design, the way a scanned label does (ADR-0075). */
export const OPEN_ELSEWHERE_EVENT = 'fathom:open-elsewhere';

export function openElsewhere(designId: string, nodeId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_ELSEWHERE_EVENT, { detail: { designId, nodeId } }));
}

/** One far end of a link between sites, as the index has it (ADR-0079 decision 5).
 * `here`: the port is there. `gone`: that design no longer has it. `closed`: a design this
 * person can't open, or one that doesn't exist. `behind`: that design is still being indexed. */
export interface FarAnswer {
  design: string;
  element: string;
  state: 'here' | 'gone' | 'closed' | 'behind';
  designName: string | null;
  device: string;
  port: string;
  /** Where the far port's own link points, if it has one. */
  back: { design: string; element: string } | null;
}

export function parseFar(bytes: Uint8Array): FarAnswer[] {
  const raw = JSON.parse(new TextDecoder().decode(bytes)) as { ends?: unknown[] };
  return (raw.ends ?? []).map((e): FarAnswer => {
    const o = (e ?? {}) as Record<string, unknown>;
    const state = str(o.state);
    const back = Array.isArray(o.back) && o.back.length === 2 ? { design: str(o.back[0]), element: str(o.back[1]) } : null;
    return {
      design: str(o.design),
      element: str(o.element),
      state: state === 'here' || state === 'gone' || state === 'behind' ? state : 'closed',
      designName: typeof o.designName === 'string' ? o.designName : null,
      device: str(o.device),
      port: str(o.port),
      back,
    };
  });
}

/** At most this many far ends per request; the server refuses more. */
export const FAR_PER_REQUEST = 64;

export async function fetchFarEnds(organisationId: string, ends: ReadonlyArray<{ design: string; element: string }>): Promise<FarAnswer[]> {
  const path = `/organisations/${encodeURIComponent(organisationId)}/estate/far`;
  const out: FarAnswer[] = [];
  for (let i = 0; i < ends.length; i += FAR_PER_REQUEST) {
    const chunk = ends.slice(i, i + FAR_PER_REQUEST).map((e) => [e.design, e.element]);
    out.push(...parseFar(await signedFetch('POST', path, body({ ends: chunk }))));
  }
  return out;
}
