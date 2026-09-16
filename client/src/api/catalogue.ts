// The device catalogue — `GET /catalogue/models` and
// `GET /catalogue/models/{vendor}/{model}`, `crates/fathom-server/src/design_api.rs`'s
// `catalogue_list_handler` / `catalogue_model_handler`. Shapes read off
// `json_of_model` / `json_of_faceplate` / `json_of_port` / `json_of_psu_slot`
// there, not assumed: a port on the wire is `kind` (the catalogue's own
// connector token, e.g. `"RJ45"`, `"SFP+"` — a different vocabulary from the
// schema's `PhysicalPort.connector` enum, deliberately not reconciled here),
// `number` (the silkscreen number, `null` for a named port — see below),
// `name` (the vendor's own word for a named port, e.g. `"me0"`, `null` for a
// numbered one — ADR-0050 §5; a port carries exactly one of `number`/`name`),
// `uplink`, `role` (`"access"` / `"uplink"` / `"management"` / `"console"` —
// the fuller picture `uplink` is one bit of), `row` (`"top"` / `"bottom"` /
// `"single"`), `column` and `group_gap_before`. There is no `label` key on a
// port — the silkscreen number or the name is the label. `name` and `role`
// are typed optional here even though the server always sends them: the
// document and drawing builders that will consume them are next round's work
// (this task's brief), and this file must not force every existing fixture
// in `client/src/document`/`client/src/components` that already builds a
// `CataloguePort` literal without them to be edited outside this task's
// files. `parsePort` below still reads both off every real response.
//
// `psuSlots` (wire: `psu_slots`) is model-level, not per-port, and is a list,
// never `null` — an empty list is how the server says "no PSU inlet on this
// model at all" (ADR-0050 §3/§4's `PsuSlot`; see
// `crates/fathom-corpus/src/catalogue.rs`'s module doc on why it carries no
// connector `kind` any more).

import { signedFetch } from './signedFetch';

export interface CatalogueSource {
  cite: string;
  readOn: string;
}

export interface CatalogueSlotPosition {
  row: 'top' | 'bottom' | 'single';
  column: number;
}

/** A power-supply bay, positioned on a face like a port (ADR-0050 §3/§4) —
 * never a count. `hotSwap: false` records a fixed, non-removable supply; the
 * model still has an inlet, it is just not a field-replaceable one. */
export interface CataloguePsuSlot {
  name: string;
  hotSwap: boolean;
  face: 'front' | 'rear';
  position: CatalogueSlotPosition;
}

export interface CataloguePort {
  kind: string;
  number: number | null;
  name?: string | null;
  uplink: boolean;
  role?: 'access' | 'uplink' | 'management' | 'console';
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
  psuSlots: CataloguePsuSlot[];
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

function nullableNum(v: unknown, what: string): number | null {
  if (v === null) return null;
  return num(v, what);
}

function nullableStr(v: unknown, what: string): string | null {
  if (v === null) return null;
  return str(v, what);
}

function parseRow(v: unknown, what: string): 'top' | 'bottom' | 'single' {
  const row = str(v, what);
  if (row !== 'top' && row !== 'bottom' && row !== 'single') {
    throw malformed(`${what} is not one of top / bottom / single`);
  }
  return row;
}

function parseFace(v: unknown, what: string): 'front' | 'rear' {
  const face = str(v, what);
  if (face !== 'front' && face !== 'rear') {
    throw malformed(`${what} is not front / rear`);
  }
  return face;
}

function parseRole(v: unknown, what: string): 'access' | 'uplink' | 'management' | 'console' {
  const role = str(v, what);
  if (role !== 'access' && role !== 'uplink' && role !== 'management' && role !== 'console') {
    throw malformed(`${what} is not one of access / uplink / management / console`);
  }
  return role;
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
  return {
    kind: str(m.kind, `${path}.kind`),
    number: nullableNum(m.number, `${path}.number`),
    name: nullableStr(m.name, `${path}.name`),
    uplink: bool(m.uplink, `${path}.uplink`),
    role: parseRole(m.role, `${path}.role`),
    row: parseRow(m.row, `${path}.row`),
    column: num(m.column, `${path}.column`),
    groupGapBefore: bool(m.group_gap_before, `${path}.group_gap_before`),
  };
}

function parseFaceplate(v: unknown, path: string): CatalogueFaceplate {
  const m = obj(v, path);
  return {
    face: parseFace(m.face, `${path}.face`),
    portCount: num(m.port_count, `${path}.port_count`),
    ports: arr(m.ports, `${path}.ports`).map((p, i) => parsePort(p, `${path}.ports[${i}]`)),
  };
}

function parsePsuSlot(v: unknown, path: string): CataloguePsuSlot {
  const m = obj(v, path);
  const position = obj(m.position, `${path}.position`);
  return {
    name: str(m.name, `${path}.name`),
    hotSwap: bool(m.hot_swap, `${path}.hot_swap`),
    face: parseFace(m.face, `${path}.face`),
    position: {
      row: parseRow(position.row, `${path}.position.row`),
      column: num(position.column, `${path}.position.column`),
    },
  };
}

export function parseCatalogueModel(bytes: Uint8Array): CatalogueModel {
  const m = obj(parseJson(bytes, 'catalogue model'), 'catalogue model body');
  const source = obj(m.source, 'catalogue model.source');
  return {
    vendor: str(m.vendor, 'catalogue model.vendor'),
    model: str(m.model, 'catalogue model.model'),
    rackUnits: num(m.rack_units, 'catalogue model.rack_units'),
    reviewedBy: str(m.reviewed_by, 'catalogue model.reviewed_by'),
    source: { cite: str(source.cite, 'source.cite'), readOn: str(source.read_on, 'source.read_on') },
    psuSlots: arr(m.psu_slots, 'catalogue model.psu_slots').map((s, i) =>
      parsePsuSlot(s, `psu_slots[${i}]`),
    ),
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
