// Where each device, port and rack is: site > room > rack > U, read once off the view and kept in
// maps so a list of thousands answers "where" without searching. Pure.
//
// The schema has Premises (a site), and racks stand in a named `row`; it has no Room. So the middle
// level of Where is the rack's row, and the site is the premises the closet belongs to.

import type { ClosetView, FixtureView, PortView } from '../../document/view';
import { findNode, readPremisesFields, type Document } from '../../document/model';

export interface Place {
  site: string;
  /** The row the rack stands in. */
  room: string;
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

export function buildPlaceIndex(doc: Document | null, view: ClosetView): PlaceIndex {
  const site = siteLabel(doc, view.premisesId);
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
      const rackPlace: Place = { site, room: rack.row ?? '', rack: rack.label, rackId: rack.id, u: null };
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
  const surfacePlace: Place = { site, room: '', rack: '', rackId: '', u: null };
  const walk = (fixtures: readonly FixtureView[]) => {
    for (const f of fixtures) {
      hosts.set(f.id, surfacePlace);
      for (const p of f.ports) add(p, f.id, f.label, 'surface', '', surfacePlace);
      walk(f.fixtures);
    }
  };
  for (const s of view.surfaces) walk(s.fixtures);
  for (const c of view.unplaced) for (const p of c.ports) add(p, c.id, c.hostname || 'unnamed', 'unplaced', c.role ?? '', null);

  return { site, hosts, ports, portById, racks };
}

// ---------------------------------------------------------------------------
// Where

export interface Where {
  site: string;
  room: string;
  rack: string;
}

export const NO_WHERE: Where = { site: '', room: '', rack: '' };
export const hasWhere = (w: Where): boolean => w.site !== '' || w.room !== '' || w.rack !== '';

/** True when any of the row's places is inside `w`. A row with no places is outside any set Where;
 * a row whose kind has no place at all (`places === undefined`) is never filtered by it. */
export function inWhere(places: readonly Place[] | undefined, w: Where): boolean {
  if (!hasWhere(w)) return true;
  if (places === undefined) return true;
  return places.some((p) => (w.site === '' || p.site === w.site) && (w.room === '' || p.room === w.room) && (w.rack === '' || p.rack === w.rack));
}

export interface WhereOptions {
  sites: string[];
  rooms: string[];
  racks: string[];
}

const sortedUnique = (xs: Iterable<string>): string[] => [...new Set([...xs].filter((x) => x !== ''))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

/** The choices the three selects offer, each narrowed by the ones before it. */
export function whereOptions(racks: Iterable<Place>, w: Where): WhereOptions {
  const all = [...racks];
  return {
    sites: sortedUnique(all.map((p) => p.site)),
    rooms: sortedUnique(all.filter((p) => w.site === '' || p.site === w.site).map((p) => p.room)),
    racks: sortedUnique(all.filter((p) => (w.site === '' || p.site === w.site) && (w.room === '' || p.room === w.room)).map((p) => p.rack)),
  };
}

export const whereText = (w: Where): string => [w.site, w.room, w.rack].filter((x) => x !== '').join(' › ');
export const placeText = (p: Place): string => [p.site, p.room, p.rack, p.u != null ? `U${p.u}` : ''].filter((x) => x !== '').join(' › ');
