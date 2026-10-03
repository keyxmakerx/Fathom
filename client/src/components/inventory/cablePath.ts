// What a cable is part of: the run it sits on, end to end, through patch panels (front on one side,
// rear on the other), with where each stop is. And what a device is plugged into. Pure; reads the
// view and the place index, writes nothing. The walk through panels is the canvas's own (`litPathFor`).

import { litPathFor } from '../drawing/paths';
import type { CableEnd, CableView, ClosetView } from '../../document/view';
import { findNode, type Document } from '../../document/model';
import type { Place, PlaceIndex, PortInfo } from './placeIndex';

export interface StationPort {
  portId: string;
  label: string;
  face: string;
}

/** A stop on the run: a device at an end, a patch panel the run passes through, or "outside". */
export interface Station {
  kind: 'end' | 'panel' | 'outside';
  hostId: string;
  /** What the host is, so its page can be opened. */
  hostKind: PortInfo['hostKind'] | null;
  host: string;
  /** One port at an end; for a panel the port the run comes in on, then the one it leaves by. */
  ports: StationPort[];
  place: Place | null;
}

export interface PathCable {
  id: string;
  label: string | null;
  media: string;
  lengthM: number | null;
}

export interface CablePath {
  /** `stations.length === cables.length + 1`; cable i joins station i to station i + 1. */
  stations: Station[];
  cables: PathCable[];
  /** The cable the page is about. */
  at: number;
}

const stationPort = (p: PortInfo): StationPort => ({ portId: p.id, label: p.label, face: p.face });

function hostOf(idx: PlaceIndex, end: CableEnd | undefined): string | null {
  return end && 'portId' in end ? (idx.portById.get(end.portId)?.hostId ?? null) : null;
}

function endStation(idx: PlaceIndex, end: CableEnd): Station {
  if ('outside' in end) return { kind: 'outside', hostId: '', hostKind: null, host: end.label || 'outside', ports: [], place: null };
  const p = idx.portById.get(end.portId);
  if (!p) return { kind: 'outside', hostId: '', hostKind: null, host: 'unknown', ports: [], place: null };
  return { kind: 'end', hostId: p.hostId, hostKind: p.hostKind, host: p.hostName, ports: [stationPort(p)], place: p.place };
}

export function cablePath(view: ClosetView, idx: PlaceIndex, cableId: string): CablePath | null {
  const byId = new Map(view.cables.map((c) => [c.id, c]));
  if (!byId.has(cableId)) return null;
  const ids = litPathFor(view, cableId, []).cableIds;
  const cables = (ids.length ? ids : [cableId]).map((id) => byId.get(id)).filter((c): c is CableView => !!c);
  if (cables.length === 0) return null;
  const at = Math.max(0, cables.findIndex((c) => c.id === cableId));

  // Which end of each cable faces the previous one (entry) and which the next (exit).
  const entry: Array<CableEnd | undefined> = [];
  const exit: Array<CableEnd | undefined> = [];
  for (let i = 0; i < cables.length; i += 1) {
    const ends = cables[i]!.ends;
    const next = cables[i + 1];
    if (i === 0) {
      const nextHosts = new Set(next ? next.ends.map((e) => hostOf(idx, e)).filter((h): h is string => !!h) : []);
      const joined = next ? ends.find((e) => nextHosts.has(hostOf(idx, e) ?? '')) : undefined;
      exit[i] = joined ?? ends[1];
      entry[i] = ends.find((e) => e !== exit[i]) ?? ends[0];
    } else {
      const prevHost = hostOf(idx, exit[i - 1]);
      entry[i] = ends.find((e) => hostOf(idx, e) === prevHost) ?? ends[0];
      exit[i] = ends.find((e) => e !== entry[i]) ?? ends[1];
    }
  }

  const stations: Station[] = [entry[0] ? endStation(idx, entry[0]) : { kind: 'outside', hostId: '', hostKind: null, host: 'unknown', ports: [], place: null }];
  for (let i = 0; i < cables.length; i += 1) {
    const arrive = exit[i];
    if (!arrive) {
      stations.push({ kind: 'outside', hostId: '', hostKind: null, host: 'unknown', ports: [], place: null });
    } else if (i < cables.length - 1 && 'portId' in arrive) {
      const into = idx.portById.get(arrive.portId);
      const out = entry[i + 1] && 'portId' in entry[i + 1]! ? idx.portById.get((entry[i + 1] as { portId: string }).portId) : undefined;
      stations.push({ kind: 'panel', hostId: into?.hostId ?? '', hostKind: into?.hostKind ?? null, host: into?.hostName ?? 'panel', ports: [into, out].filter((p): p is PortInfo => !!p).map(stationPort), place: into?.place ?? null });
    } else {
      stations.push(endStation(idx, arrive));
    }
  }
  const path: CablePath = {
    stations,
    cables: cables.map((c) => ({ id: c.id, label: c.label, media: c.media, lengthM: c.lengthM ?? null })),
    at,
  };
  // The same run reads the same way from either end: the stop whose name sorts first comes first.
  const last = stations[stations.length - 1]!;
  if (stations[0]!.host.localeCompare(last.host, undefined, { numeric: true }) > 0) {
    return {
      stations: [...stations].reverse().map((s) => ({ ...s, ports: [...s.ports].reverse() })),
      cables: [...path.cables].reverse(),
      at: cables.length - 1 - at,
    };
  }
  return path;
}

export interface PluggedInto {
  port: StationPort;
  cableId: string;
  cableLabel: string | null;
  far: { host: string; port: string; place: Place | null } | { outside: string } | null;
}

/** For each cabled port of a host: what is on the other end of its cable. */
export function pluggedInto(view: ClosetView, idx: PlaceIndex, hostId: string): PluggedInto[] {
  const cableById = new Map(view.cables.map((c) => [c.id, c]));
  const out: PluggedInto[] = [];
  for (const p of idx.ports) {
    if (p.hostId !== hostId || !p.cableId) continue;
    const cable = cableById.get(p.cableId);
    const far = cable?.ends.find((e) => !('portId' in e) || e.portId !== p.id);
    let farInfo: PluggedInto['far'] = null;
    if (far && 'outside' in far) farInfo = { outside: far.label || 'outside' };
    else if (far) {
      const f = idx.portById.get(far.portId);
      if (f) farInfo = { host: f.hostName, port: f.label, place: f.place };
    }
    out.push({ port: stationPort(p), cableId: p.cableId, cableLabel: cable?.label ?? null, far: farInfo });
  }
  return out;
}

/** "LON1 › Row A › A03 › U40" for a stop, or an empty string when it has no place. */
export function stationPlace(s: Station): string {
  const p = s.place;
  if (!p) return '';
  return [p.site, p.room, p.rack, p.u != null ? `U${p.u}` : ''].filter((x) => x !== '').join(' › ');
}

/** The page a stop opens: a chassis, a shelf occupant or a surface fixture. */
export function selectionOfHost(hostKind: PortInfo['hostKind'] | null, hostId: string): { kind: 'chassis' | 'occupant' | 'fixture'; id: string } | null {
  if (!hostKind || hostId === '') return null;
  return { kind: hostKind === 'shelf' ? 'occupant' : hostKind === 'surface' ? 'fixture' : 'chassis', id: hostId };
}

/** `Cable.last_confirmed` as written on the cable, "YYYY-MM-DD", or null when nobody has recorded one. */
export function lastTracedOf(doc: Document, cableId: string): string | null {
  const v = findNode(doc, cableId)?.fields['Cable.last_confirmed'];
  if (!v || v.presence !== 'set') return null;
  const x = v.value as unknown;
  if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)) return x;
  if (x && typeof x === 'object' && 'year' in x && 'month' in x && 'day' in x) {
    const d = x as { year: number; month: number; day: number };
    return `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
  }
  return null;
}
