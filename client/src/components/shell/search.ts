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
 * ADR-0059, this session's brief item 4 — a device, a rack or a port also
 * matches by any tag it carries, `doc` optional: a caller with no open
 * `Document` (this file's own tests) still gets name-only matching, never a
 * crash on a missing argument. */
export function searchDesign(view: Pick<ClosetView, 'racks'>, query: string, doc?: Document, limit = 12): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const has = (s: string | null | undefined) => s != null && s.toLowerCase().includes(q);
  const tagNames = (id: string): string[] => (doc ? tagsOf(doc, id).map((t) => t.name) : []);
  const hasTag = (id: string) => tagNames(id).some((n) => n.toLowerCase().includes(q));
  const tagWhy = (id: string) => {
    const hit = tagNames(id).find((n) => n.toLowerCase().includes(q));
    return hit ? `tag: ${hit}` : undefined;
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
    if (has(rack.label) || hasTag(rack.id)) {
      const why = tagWhy(rack.id) ?? `${rack.heightU}U · ${rack.chassis.length} devices`;
      hits.push({ group: 'Racks', name: rack.label, why, selection: { kind: 'rack', id: rack.id } });
    }
    for (const ch of rack.chassis) {
      const device = ch.hostname || ch.model;
      if (has(ch.hostname) || has(ch.model) || has(ch.serial) || has(ch.managementAddress) || hasTag(ch.deviceId)) {
        const why = tagWhy(ch.deviceId) ?? `${ch.model} · ${rack.label} U${ch.positionU}`;
        hits.push({ group: 'Devices', name: device, why, selection: { kind: 'chassis', id: ch.id } });
      }
      for (const port of ch.ports) {
        const name = `${device} · ${port.label}`;
        const tagHit = hasTag(port.id);
        if (!tagHit && !has(port.label) && !(has(name) && !has(device))) continue;
        const far = port.cable?.farPortId ? nameOf.get(port.cable.farPortId) : null;
        const why = tagWhy(port.id) ?? (port.cable == null ? 'free' : port.cable.outsideCloset ? 'cabled out of this closet' : `cabled to ${far ?? 'another port'}`);
        hits.push({ group: 'Ports', name, why, selection: { kind: 'port', id: port.id } });
      }
    }
  }
  // Array.prototype.sort is stable, so each group keeps rack order.
  hits.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  return hits.slice(0, limit);
}
