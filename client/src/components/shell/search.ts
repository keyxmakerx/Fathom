import { containersOnDevice } from '../../document/docker';
import type { Document } from '../../document/model';
import { deriveNetworks } from '../../document/networks-derive';
import { tagsOf } from '../../document/tags';
import type { ClosetView } from '../../document/view';
import type { Selection } from '../drawing/contract';

/** One quick-search result: what the list shows and what choosing it selects. */
export interface SearchHit {
  group: 'Devices' | 'Racks' | 'Ports' | 'Cables' | 'VLANs' | 'Containers';
  name: string;
  why: string;
  /** Where it is, short ("R1 · U40"), shown after the name in the command palette. */
  where?: string;
  selection: Selection;
}

const GROUP_ORDER: readonly SearchHit['group'][] = ['Devices', 'Racks', 'Ports', 'Cables', 'VLANs', 'Containers'];

/** Case-insensitive search of the open design, devices first; given `doc`, an object also
 * matches by its tags, and so do cables (label, tag or either end's device), VLANs (number,
 * name or tag; choosing one selects a cable that carries it) and containers (choosing one
 * selects its host). A port matches only when the query reaches past its device's name
 * ("acc-01 · 6", not "acc"). */
export function searchDesign(view: Pick<ClosetView, 'racks'> & Partial<Pick<ClosetView, 'cables'>>, query: string, doc?: Document, limit = 12): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const has = (s: string | null | undefined) => s != null && s.toLowerCase().includes(q);
  // One `tagsOf` per object, and only when its name did not already match.
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
        hits.push({ group: 'Devices', name: device, why, where: `${rack.label} · U${ch.positionU}`, selection: { kind: 'chassis', id: ch.id } });
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
  const hostOfPort = new Map<string, string>();
  for (const rack of view.racks) {
    for (const ch of rack.chassis) for (const port of ch.ports) hostOfPort.set(port.id, ch.hostname || ch.model);
  }
  for (const cable of view.cables ?? []) {
    const ends = cable.ends.map((e) => ('portId' in e ? hostOfPort.get(e.portId) : e.label));
    const labelMatches = has(cable.label);
    const endHit = labelMatches ? undefined : ends.find((n) => has(n));
    const tagHit = labelMatches || endHit ? undefined : matchingTagName(cable.id);
    if (!labelMatches && !endHit && !tagHit) continue;
    const why = tagHit ? `tag: ${tagHit}` : `${ends.map((n) => n ?? '—').join(' ↔ ')}`;
    hits.push({ group: 'Cables', name: cable.label || 'Unlabelled cable', why, selection: { kind: 'cable', id: cable.id } });
  }

  if (doc) {
    const cablesByVlan = new Map<number, string[]>();
    const { vlanRows } = deriveNetworks(doc);
    for (const row of vlanRows) {
      const ids = row.members.map((m) => m.cableId).filter((c): c is string => c != null);
      if (ids.length > 0) cablesByVlan.set(row.vlanId, [...new Set([...(cablesByVlan.get(row.vlanId) ?? []), ...ids])]);
    }
    for (const row of vlanRows) {
      const numberMatches = String(row.vlanId) === q || has(`vlan ${row.vlanId}`) || has(row.name);
      let tagHit: string | undefined;
      if (!numberMatches) {
        for (const id of row.vlanNodeIds) {
          tagHit = matchingTagName(id);
          if (tagHit) break;
        }
      }
      if (!numberMatches && !tagHit) continue;
      const carrying = cablesByVlan.get(row.vlanId) ?? [];
      if (carrying.length === 0) continue; // nothing on the canvas to show
      const why = tagHit ? `tag: ${tagHit}` : `${carrying.length} cable${carrying.length === 1 ? '' : 's'}`;
      hits.push({ group: 'VLANs', name: row.name ? `VLAN ${row.vlanId} · ${row.name}` : `VLAN ${row.vlanId}`, why, selection: { kind: 'cable', id: carrying[0] } });
    }

    for (const rack of view.racks) {
      for (const ch of rack.chassis) {
        for (const c of containersOnDevice(doc, ch.deviceId)) {
          const nameMatches = has(c.name);
          const tagHit = nameMatches ? undefined : matchingTagName(c.id);
          if (!nameMatches && !tagHit) continue;
          hits.push({ group: 'Containers', name: c.name, why: tagHit ? `tag: ${tagHit}` : `on ${ch.hostname || ch.model}`, selection: { kind: 'chassis', id: ch.id } });
        }
      }
    }
  }
  // Array.prototype.sort is stable, so each group keeps rack order.
  hits.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  return hits.slice(0, limit);
}
