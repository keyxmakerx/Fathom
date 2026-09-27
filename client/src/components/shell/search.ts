import type { Document } from '../../document/model';
import { tagsOf } from '../../document/tags';
import type { ClosetView } from '../../document/view';
import type { Selection } from '../drawing/contract';

/** One quick-search result: what the list shows and what choosing it selects. */
export interface SearchHit {
  group: 'Devices' | 'Racks' | 'Ports';
  name: string;
  why: string;
  selection: Selection;
}

const GROUP_ORDER: readonly SearchHit['group'][] = ['Devices', 'Racks', 'Ports'];

/** Case-insensitive search of the open design, devices first. A port matches
 * only when the query reaches past its device's name ("acc-01 · 6", not "acc").
 *
 * ADR-0059 — a device, a rack or a port also matches by any tag it
 * carries, `doc` optional: a caller with no open
 * `Document` (this file's own tests) still gets name-only matching, never a
 * crash on a missing argument. */
export function searchDesign(view: Pick<ClosetView, 'racks'>, query: string, doc?: Document, limit = 12): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const has = (s: string | null | undefined) => s != null && s.toLowerCase().includes(q);
  // One `tagsOf` call per object, not two (a prior `hasTag`-then-`tagWhy`
  // shape called it twice for every match) -- at 2,100 devices this halves
  // the per-object cost the index build itself does not cover.
  const matchingTagName = (id: string): string | undefined => {
    if (!doc) return undefined;
    for (const chip of tagsOf(doc, id)) {
      if (chip.name.toLowerCase().includes(q)) return chip.name;
    }
    return undefined;
  };

  const nameOf = new Map<string, string>();
  for (const rack of view.racks) {
    for (const ch of rack.chassis) {
      const device = ch.hostname || ch.model;
      for (const port of ch.ports) nameOf.set(port.id, `${device} · ${port.label}`);
    }
  }

  const hits: SearchHit[] = [];
  for (const rack of view.racks) {
    const rackNameMatches = has(rack.label);
    const rackTagHit = rackNameMatches ? undefined : matchingTagName(rack.id);
    if (rackNameMatches || rackTagHit) {
      const why = rackTagHit ? `tag: ${rackTagHit}` : `${rack.heightU}U · ${rack.chassis.length} devices`;
      hits.push({ group: 'Racks', name: rack.label, why, selection: { kind: 'rack', id: rack.id } });
    }
    for (const ch of rack.chassis) {
      const device = ch.hostname || ch.model;
      const deviceNameMatches = has(ch.hostname) || has(ch.model) || has(ch.serial) || has(ch.managementAddress);
      const deviceTagHit = deviceNameMatches ? undefined : matchingTagName(ch.deviceId);
      if (deviceNameMatches || deviceTagHit) {
        const why = deviceTagHit ? `tag: ${deviceTagHit}` : `${ch.model} · ${rack.label} U${ch.positionU}`;
        hits.push({ group: 'Devices', name: device, why, selection: { kind: 'chassis', id: ch.id } });
      }
      for (const port of ch.ports) {
        const name = `${device} · ${port.label}`;
        const portNameMatches = has(port.label) || (has(name) && !has(device));
        const portTagHit = portNameMatches ? undefined : matchingTagName(port.id);
        if (!portNameMatches && !portTagHit) continue;
        const far = port.cable?.farPortId ? nameOf.get(port.cable.farPortId) : null;
        const why = portTagHit ? `tag: ${portTagHit}` : (port.cable == null ? 'free' : port.cable.outsideCloset ? 'cabled out of this closet' : `cabled to ${far ?? 'another port'}`);
        hits.push({ group: 'Ports', name, why, selection: { kind: 'port', id: port.id } });
      }
    }
  }
  // Array.prototype.sort is stable, so each group keeps rack order.
  hits.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  return hits.slice(0, limit);
}
