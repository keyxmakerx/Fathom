// The device catalogue — `GET /catalogue/models` and
// `GET /catalogue/models/{vendor}/{model}`, `crates/fathom-server/src/design_api.rs`'s
// `catalogue_list_handler` / `catalogue_model_handler`. Shapes read off
// `json_of_model` / `json_of_faceplate` / `json_of_port` there, not assumed:
// a port on the wire is `kind` (the catalogue's own connector token, e.g.
// `"RJ45"`, `"SFP+"` — a different vocabulary from the schema's
// `PhysicalPort.connector` enum, deliberately not reconciled here), `number`
// (the silkscreen number), `uplink`, `row` (`"top"` / `"bottom"` / `"single"`),
// `column` and `group_gap_before`. There is no `label` key on a port — the
// silkscreen number is the label — and `psu_inlets` is model-level, not
// per-port.

import { signedFetch } from './signedFetch';

export interface CatalogueSource {
  cite: string;
  readOn: string;
}

export interface CataloguePsuInlets {
  kind: string;
  count: number;
}

export interface CataloguePort {
  kind: string;
  number: number;
  uplink: boolean;
  row: 'top' | 'bottom' | 'single';
  column: number;
  groupGapBefore: boolean;
}

export interface CatalogueFaceplate {
  face: 'front' | 'rear';
  portCount: number;
  ports: CataloguePort[];
}

/** One catalogue entry's full detail (`GET /catalogue/models/{vendor}/{model}`). */
export interface CatalogueModel {
  vendor: string;
  model: string;
  rackUnits: number;
  reviewedBy: string;
  source: CatalogueSource;
  psuInlets: CataloguePsuInlets | null;
  faceplates: CatalogueFaceplate[];
}

/** One row of `GET /catalogue/models` — vendor, model and height only; a
 * caller wanting ports and faceplates follows up with `fetchModel`. */
export interface CatalogueListEntry {
  vendor: string;
  model: string;
  rackUnits: number;
}

function malformed(what: string): Error {
  return new Error(`malformed catalogue response: ${what}`);
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw malformed(what);
  return v as Record<string, unknown>;
}

function arr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw malformed(what);
  return v;
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string') throw malformed(what);
  return v;
}

function num(v: unknown, what: string): number {
  if (typeof v !== 'number') throw malformed(what);
  return v;
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') throw malformed(what);
  return v;
}

function parseJson(bytes: Uint8Array, what: string): unknown {
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    throw malformed(`${what} is not JSON`);
  }
}

export function parseCatalogueList(bytes: Uint8Array): CatalogueListEntry[] {
  const parsed = arr(parseJson(bytes, 'catalogue list'), 'catalogue list body');
  return parsed.map((entry, i) => {
    const m = obj(entry, `catalogue list entry ${i}`);
    return {
      vendor: str(m.vendor, `catalogue list entry ${i}.vendor`),
      model: str(m.model, `catalogue list entry ${i}.model`),
      rackUnits: num(m.rack_units, `catalogue list entry ${i}.rack_units`),
    };
  });
}

function parsePort(v: unknown, path: string): CataloguePort {
  const m = obj(v, path);
  const row = str(m.row, `${path}.row`);
  if (row !== 'top' && row !== 'bottom' && row !== 'single') {
    throw malformed(`${path}.row is not one of top / bottom / single`);
  }
  return {
    kind: str(m.kind, `${path}.kind`),
    number: num(m.number, `${path}.number`),
    uplink: bool(m.uplink, `${path}.uplink`),
    row,
    column: num(m.column, `${path}.column`),
    groupGapBefore: bool(m.group_gap_before, `${path}.group_gap_before`),
  };
}

function parseFaceplate(v: unknown, path: string): CatalogueFaceplate {
  const m = obj(v, path);
  const face = str(m.face, `${path}.face`);
  if (face !== 'front' && face !== 'rear') {
    throw malformed(`${path}.face is not front / rear`);
  }
  return {
    face,
    portCount: num(m.port_count, `${path}.port_count`),
    ports: arr(m.ports, `${path}.ports`).map((p, i) => parsePort(p, `${path}.ports[${i}]`)),
  };
}

export function parseCatalogueModel(bytes: Uint8Array): CatalogueModel {
  const m = obj(parseJson(bytes, 'catalogue model'), 'catalogue model body');
  const source = obj(m.source, 'catalogue model.source');
  const psuInletsRaw = m.psu_inlets;
  const psuInlets =
    psuInletsRaw === null
      ? null
      : (() => {
          const p = obj(psuInletsRaw, 'catalogue model.psu_inlets');
          return { kind: str(p.kind, 'psu_inlets.kind'), count: num(p.count, 'psu_inlets.count') };
        })();
  return {
    vendor: str(m.vendor, 'catalogue model.vendor'),
    model: str(m.model, 'catalogue model.model'),
    rackUnits: num(m.rack_units, 'catalogue model.rack_units'),
    reviewedBy: str(m.reviewed_by, 'catalogue model.reviewed_by'),
    source: { cite: str(source.cite, 'source.cite'), readOn: str(source.read_on, 'source.read_on') },
    psuInlets,
    faceplates: arr(m.faceplates, 'catalogue model.faceplates').map((f, i) =>
      parseFaceplate(f, `faceplates[${i}]`),
    ),
  };
}

export async function fetchCatalogue(): Promise<CatalogueListEntry[]> {
  const bytes = await signedFetch('GET', '/catalogue/models');
  return parseCatalogueList(bytes);
}

export async function fetchModel(vendor: string, model: string): Promise<CatalogueModel> {
  const path = `/catalogue/models/${encodeURIComponent(vendor)}/${encodeURIComponent(model)}`;
  const bytes = await signedFetch('GET', path);
  return parseCatalogueModel(bytes);
}
