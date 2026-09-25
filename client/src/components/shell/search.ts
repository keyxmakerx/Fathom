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
 * only when the query reaches past its device's name ("acc-01 · 6", not "acc"). */
export function searchDesign(view: Pick<ClosetView, 'racks'>, query: string, limit = 12): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const has = (s: string | null | undefined) => s != null && s.toLowerCase().includes(q);

  const nameOf = new Map<string, string>();
  for (const rack of view.racks) {
    for (const ch of rack.chassis) {
      const device = ch.hostname || ch.model;
      for (const port of ch.ports) nameOf.set(port.id, `${device} · ${port.label}`);
    }
  }

  const hits: SearchHit[] = [];
  for (const rack of view.racks) {
    if (has(rack.label)) {
      hits.push({ group: 'Racks', name: rack.label, why: `${rack.heightU}U · ${rack.chassis.length} devices`, selection: { kind: 'rack', id: rack.id } });
    }
    for (const ch of rack.chassis) {
      const device = ch.hostname || ch.model;
      if (has(ch.hostname) || has(ch.model) || has(ch.serial) || has(ch.managementAddress)) {
        hits.push({ group: 'Devices', name: device, why: `${ch.model} · ${rack.label} U${ch.positionU}`, selection: { kind: 'chassis', id: ch.id } });
      }
      for (const port of ch.ports) {
        const name = `${device} · ${port.label}`;
        if (!has(port.label) && !(has(name) && !has(device))) continue;
        const far = port.cable?.farPortId ? nameOf.get(port.cable.farPortId) : null;
        const why = port.cable == null ? 'free' : port.cable.outsideCloset ? 'cabled out of this closet' : `cabled to ${far ?? 'another port'}`;
        hits.push({ group: 'Ports', name, why, selection: { kind: 'port', id: port.id } });
      }
    }
  }
  // Array.prototype.sort is stable, so each group keeps rack order.
  hits.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  return hits.slice(0, limit);
}
