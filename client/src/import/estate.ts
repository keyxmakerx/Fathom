// ADR-0074 §8: a NetBox export fills sites, locations and racks, as one plan to accept. NetBox's
// `site` and `location` columns, which the in-design import recognises and drops, become folders:
// each site a Site, each location a Building under it. Each location's racks become one new
// design in that folder, standing in a row named after the location. Devices are not placed here:
// once the racks exist, each design's own Import places them by rack and unit, as it does today.
//
// Pure: reads a gated table (never raw text) and the folders the person can see. Nothing here
// writes; `buildRacksDocument` makes the document the accept step saves.

import type { Scope } from '../api/scopes';
import { emptyDocument, type Document } from '../document/model';
import { setRackField } from '../document/edit';
import { addRack } from '../components/racks/emptyDesign';
import type { GatedTable } from './table';
import { normKey, oneLine } from './text';

const SITE_KEYS = ['site', 'site_name', 'site_display'];
const LOCATION_KEYS = ['location', 'location_name', 'location_display'];
const RACK_KEYS = ['rack', 'rack_name', 'rack_display'];
const HEIGHT_KEYS = ['u_height', 'height_u', 'height', 'u_height_units'];

/** The ordinary full rack, when the file does not say. */
export const DEFAULT_RACK_U = 42;
/** NetBox allows 1 to 100 units. */
const MAX_RACK_U = 100;

export interface RackPlan {
  name: string;
  heightU: number;
  /** Devices the file places in this rack. */
  devices: number;
}

export interface LocationPlan {
  /** `''` for racks the file gives a site and no location: they go in the site's own folder. */
  name: string;
  /** The Building folder already there with this name, under the site. */
  existing: Scope | null;
  /** That folder already holds a design, so no second one is made (a re-import adds nothing). */
  hasDesign: boolean;
  racks: RackPlan[];
}

export interface SitePlan {
  name: string;
  existing: Scope | null;
  locations: LocationPlan[];
}

export interface EstatePlan {
  /** `racks` for a NetBox rack export, `devices` for a device export. */
  from: 'racks' | 'devices';
  sites: SitePlan[];
  /** Rows with no site, which nothing here can place. */
  skipped: number;
}

/** Whether the file can say where things are: it has a site column. */
export function hasSites(table: GatedTable): boolean {
  return columnOf(table, SITE_KEYS) >= 0;
}

function columnOf(table: GatedTable, keys: readonly string[]): number {
  const norm = table.headers.map(normKey);
  for (const k of keys) {
    const i = norm.indexOf(k);
    if (i >= 0) return i;
  }
  return -1;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The plan. A rack export (a `name` column and no `rack` column) lists racks by name; a device
 * export names each device's rack, and racks are counted from it. Folders are matched by name,
 * letter case aside: a site to a Site folder, a location to a Building folder under it.
 */
export function estatePlan(table: GatedTable, scopes: readonly Scope[], designScopeIds: readonly string[]): EstatePlan {
  const siteCol = columnOf(table, SITE_KEYS);
  const locCol = columnOf(table, LOCATION_KEYS);
  const rackCol = columnOf(table, RACK_KEYS);
  const nameCol = columnOf(table, ['name']);
  const heightCol = columnOf(table, HEIGHT_KEYS);
  const from: EstatePlan['from'] = rackCol < 0 && nameCol >= 0 ? 'racks' : 'devices';
  const cell = (r: readonly string[], i: number) => (i >= 0 ? oneLine(r[i] ?? '').trim().slice(0, 100) : '');

  const sites = new Map<string, { name: string; locations: Map<string, { name: string; racks: Map<string, RackPlan> }> }>();
  let skipped = 0;
  for (const r of table.rows) {
    const site = cell(r, siteCol);
    if (!site) {
      skipped += 1;
      continue;
    }
    const loc = cell(r, locCol);
    const rack = from === 'racks' ? cell(r, nameCol) : cell(r, rackCol);
    const s = sites.get(site.toLowerCase()) ?? { name: site, locations: new Map() };
    sites.set(site.toLowerCase(), s);
    const l = s.locations.get(loc.toLowerCase()) ?? { name: loc, racks: new Map() };
    s.locations.set(loc.toLowerCase(), l);
    if (!rack) continue;
    const height = Number.parseInt(cell(r, heightCol), 10);
    const plan = l.racks.get(rack.toLowerCase()) ?? {
      name: rack,
      heightU: Number.isInteger(height) && height >= 1 && height <= MAX_RACK_U ? height : DEFAULT_RACK_U,
      devices: 0,
    };
    if (from === 'devices') plan.devices += 1;
    l.racks.set(rack.toLowerCase(), plan);
  }

  const withDesigns = new Set(designScopeIds);
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return {
    from,
    skipped,
    sites: [...sites.values()].sort(byName).map((s) => {
      const existing = scopes.find((f) => f.kind === 'network' && same(f.displayName, s.name)) ?? null;
      return {
        name: s.name,
        existing,
        locations: [...s.locations.values()].sort(byName).map((l) => {
          const folder = l.name === '' ? existing : existing ? (scopes.find((f) => f.kind === 'building' && f.parentScopeId === existing.scopeId && same(f.displayName, l.name)) ?? null) : null;
          return {
            name: l.name,
            existing: l.name === '' ? null : folder,
            hasDesign: folder != null && withDesigns.has(folder.scopeId),
            racks: [...l.racks.values()].sort(byName),
          };
        }),
      };
    }),
  };
}

/** What accepting the plan makes, counted for its button. */
export function planCounts(plan: EstatePlan): { sites: number; buildings: number; designs: number; racks: number } {
  let sites = 0;
  let buildings = 0;
  let designs = 0;
  let racks = 0;
  for (const s of plan.sites) {
    if (!s.existing) sites += 1;
    for (const l of s.locations) {
      if (l.name !== '' && !l.existing) buildings += 1;
      if (l.racks.length > 0 && !l.hasDesign) {
        designs += 1;
        racks += l.racks.length;
      }
    }
  }
  return { sites, buildings, designs, racks };
}

/** One location's racks as a new document: one row named after the location, bays in name order. */
export function buildRacksDocument(row: string, racks: readonly RackPlan[], opts: { actor: string; now: number }): Document {
  let doc = emptyDocument();
  let premisesId: string | null = null;
  racks.forEach((rack, i) => {
    const made = addRack(doc, premisesId, { label: rack.name, heightU: rack.heightU, ...opts });
    premisesId = made.premisesId;
    doc = setRackField(made.doc, made.rackId, 'row', row, opts);
    doc = setRackField(doc, made.rackId, 'bay', i + 1, opts);
  });
  return doc;
}
