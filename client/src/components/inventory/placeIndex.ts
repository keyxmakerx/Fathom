// Where each device, port and rack is: site > row > rack > U, read once off the view and kept in
// maps so a list of thousands answers "where" without searching. Pure.
//
// The schema has Premises (a site), and racks stand in a named `row`; it has no Room. So the middle
// level of Where is the rack's row, and the site is the premises the closet belongs to.

import type { AllPremisesView, ClosetView, FixtureView, PortView } from '../../document/view';
import { findNode, readPremisesFields, type Document } from '../../document/model';

export interface Place {
  site: string;
  /** The row the rack stands in. */
  row: string;
  rack: string;
  rackId: string;
  /** The unit the host starts at, when it is racked directly. */
  u: number | null;
}

export interface PortInfo {
  id: string;
  label: string;
  connector: string;
  face: string;
  service: string | null;
  uplink: boolean;
  cableId: string | null;
  hostId: string;
  hostName: string;
  hostKind: 'chassis' | 'shelf' | 'surface' | 'unplaced';
  role: string;
  place: Place | null;
}

export interface PlaceIndex {
  site: string;
  /** Site name (premises label) -> the premises node id, to add a new rack or device to the one chosen in Where. */
  premisesOfSite: ReadonlyMap<string, string>;
  /** Host id (chassis, shelf occupant or fixture) -> place. */
  hosts: ReadonlyMap<string, Place>;
  /** Every port, in the order the view lists them. */
  ports: readonly PortInfo[];
  portById: ReadonlyMap<string, PortInfo>;
  racks: ReadonlyMap<string, Place>;
}

export function siteLabel(doc: Document | null, premisesId: string): string {
  if (!doc || premisesId === '') return '';
  const node = findNode(doc, premisesId);
  return (node ? readPremisesFields(node).label : undefined) || 'Premises';
}

/** Each premises' name, told apart when two share a label: the Where bar lists them as sites. */
function siteNames(doc: Document | null, view: ClosetView): { site: string; ofRack: Map<string, string>; ofSurface: Map<string, string>; idOfSite: Map<string, string> } {
  const idOfSite = new Map<string, string>();
  const ofRack = new Map<string, string>();
  const ofSurface = new Map<string, string>();
  const site = siteLabel(doc, view.premisesId);
  const list = (view as Partial<AllPremisesView>).premises;
  if (!list || list.length <= 1) {
    if (view.premisesId !== '') idOfSite.set(site, view.premisesId);
    return { site, ofRack, ofSurface, idOfSite };
  }
  const used = new Map<string, number>();
  let first = site;
  for (const [i, p] of list.entries()) {
    const base = siteLabel(doc, p.id) || 'Premises';
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    const name = n === 1 ? base : `${base} (${n})`;
    if (i === 0) first = name;
    idOfSite.set(name, p.id);
    for (const r of p.rackIds) ofRack.set(r, name);
    for (const s of p.surfaceIds) ofSurface.set(s, name);
  }
  return { site: first, ofRack, ofSurface, idOfSite };
}

export function buildPlaceIndex(doc: Document | null, view: ClosetView): PlaceIndex {
  const { site, ofRack, ofSurface, idOfSite } = siteNames(doc, view);
  const hosts = new Map<string, Place>();
  const ports: PortInfo[] = [];
  const portById = new Map<string, PortInfo>();
  const racks = new Map<string, Place>();

  const add = (p: PortView, hostId: string, hostName: string, hostKind: PortInfo['hostKind'], role: string, place: Place | null) => {
    const info: PortInfo = {
      id: p.id,
      label: p.label,
      connector: p.connector,
      face: p.face,
      service: p.service ?? null,
      uplink: p.uplink,
      cableId: p.cable?.cableId ?? null,
      hostId,
      hostName,
      hostKind,
      role,
      place,
    };
    ports.push(info);
    portById.set(p.id, info);
  };

  for (const row of view.rows) {
    for (const rack of row.racks) {
      const rackPlace: Place = { site: ofRack.get(rack.id) ?? site, row: rack.row ?? '', rack: rack.label, rackId: rack.id, u: null };
      racks.set(rack.id, rackPlace);
      for (const c of rack.chassis) {
        const place = { ...rackPlace, u: c.positionU };
        hosts.set(c.id, place);
        for (const p of c.ports) add(p, c.id, c.hostname || 'unnamed', 'chassis', c.role ?? '', place);
      }
      for (const shelf of rack.shelves) {
        const place = { ...rackPlace, u: shelf.positionU };
        for (const o of shelf.occupants) {
          hosts.set(o.id, place);
          for (const p of o.ports) add(p, o.id, o.label, 'shelf', '', place);
        }
      }
    }
  }
  let surfacePlace: Place = { site, row: '', rack: '', rackId: '', u: null };
  const walk = (fixtures: readonly FixtureView[]) => {
    for (const f of fixtures) {
      hosts.set(f.id, surfacePlace);
      for (const p of f.ports) add(p, f.id, f.label, 'surface', '', surfacePlace);
      walk(f.fixtures);
    }
  };
  for (const s of view.surfaces) {
    surfacePlace = { site: ofSurface.get(s.id) ?? site, row: '', rack: '', rackId: '', u: null };
    walk(s.fixtures);
  }
  for (const c of view.unplaced) for (const p of c.ports) add(p, c.id, c.hostname || 'unnamed', 'unplaced', c.role ?? '', null);

  return { site, premisesOfSite: idOfSite, hosts, ports, portById, racks };
}

// ---------------------------------------------------------------------------
// Where

export interface Where {
  site: string;
  row: string;
  rack: string;
}

export const NO_WHERE: Where = { site: '', row: '', rack: '' };
export const hasWhere = (w: Where): boolean => w.site !== '' || w.row !== '' || w.rack !== '';

/** True when any of the row's places is inside `w`. A row with no places is outside any set Where;
 * a row whose kind has no place at all (`places === undefined`) is never filtered by it. */
export function inWhere(places: readonly Place[] | undefined, w: Where): boolean {
  if (!hasWhere(w)) return true;
  if (places === undefined) return true;
  return places.some((p) => (w.site === '' || p.site === w.site) && (w.row === '' || p.row === w.row) && (w.rack === '' || p.rack === w.rack));
}

export interface WhereOptions {
  sites: string[];
  rows: string[];
  racks: string[];
}

const sortedUnique = (xs: Iterable<string>): string[] => [...new Set([...xs].filter((x) => x !== ''))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

/** The choices the three selects offer, each narrowed by the ones before it. */
export function whereOptions(racks: Iterable<Place>, w: Where): WhereOptions {
  const all = [...racks];
  return {
    sites: sortedUnique(all.map((p) => p.site)),
    rows: sortedUnique(all.filter((p) => w.site === '' || p.site === w.site).map((p) => p.row)),
    racks: sortedUnique(all.filter((p) => (w.site === '' || p.site === w.site) && (w.row === '' || p.row === w.row)).map((p) => p.rack)),
  };
}

export const whereText = (w: Where): string => [w.site, w.row, w.rack].filter((x) => x !== '').join(' › ');
export const placeText = (p: Place): string => [p.site, p.row, p.rack, p.u != null ? `U${p.u}` : ''].filter((x) => x !== '').join(' › ');
