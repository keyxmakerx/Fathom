/** The Links lens on the canvas (sign-off r109, borrowed from homelab-diagram's grammar, drawn in
 * Fathom's own theme). It changes how the same lines are drawn; it never moves or hides a box
 * (ADR-0047 §1), and it never colours a box: a coloured box means a warning.
 *
 * - An access line, carrying one VLAN, is drawn in that VLAN's colour (`--vlan-1` … `--vlan-6`, then
 *   they repeat). A line with no VLAN stays ink.
 * - A trunk, carrying more than one VLAN or marked trunk, is drawn hollow: ink with a page core, so it
 *   never reads as dashed (proposed) or dotted (pending).
 * - A line's weight says its speed, read from `Interface.speed` at either end (the slower end wins).
 *   No speed set draws the plain copper weight. The Cables lens keeps "type is the line".
 * - The Networks key lists each VLAN with its colour, name and subnet.
 *
 * Pure; read off the design alone, with no new field. */

import { edgesIn, edgesOut, findNode, type Document } from '../../document/model';
import { deriveNetworks } from '../../document/networks-derive';
import type { ClosetView } from './contract';

/** How many VLAN colours the tokens hold before they repeat. */
export const VLAN_SLOTS = 6;

export interface LinksLine {
  /** The VLAN ids the line carries, smallest first. */
  vlans: number[];
  trunk: boolean;
  /** The colour slot (1-based) of an access line's VLAN; null for a trunk or a line with no VLAN. */
  slot: number | null;
  /** The slower end's configured speed, in bits per second; null when neither end says. */
  speedBps: number | null;
}

export interface LinksKeyRow {
  vlanId: number;
  name?: string;
  cidr?: string;
  slot: number;
}

export interface LinksMarks {
  cables: Map<string, LinksLine>;
  key: LinksKeyRow[];
}

const EMPTY: LinksMarks = { cables: new Map(), key: [] };

/** The stroke weight for a speed, in px: thicker is faster. No speed draws the copper weight. */
export function speedWidth(bps: number | null): number {
  if (bps == null) return 1.2;
  if (bps >= 10e9) return 3.6;
  if (bps >= 2.5e9) return 2.6;
  if (bps >= 1e9) return 1.8;
  return 1.2;
}

/** A trunk is drawn hollow, so it needs room for its page core whatever its speed. */
export const TRUNK_MIN_W = 3.2;

/** `10G`, `2.5G`, `1G`, `100M`: the short form a speed tag writes. */
export function speedText(bps: number): string {
  if (bps >= 1e9) return `${+(bps / 1e9).toFixed(1)}G`;
  if (bps >= 1e6) return `${+(bps / 1e6).toFixed(1)}M`;
  return `${bps}`;
}

function speedOf(doc: Document, interfaceId: string): number | null {
  const f = findNode(doc, interfaceId)?.fields['Interface.speed'];
  if (f?.presence !== 'set') return null;
  const v = typeof f.value === 'number' ? f.value : typeof f.value === 'string' ? Number(f.value) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function linksMarks(doc: Document | null, view: ClosetView): LinksMarks {
  if (doc == null) return EMPTY;
  const net = deriveNetworks(doc);

  // Colour slots follow the VLAN ids in order, so a VLAN keeps its colour as the design grows.
  const ids = [...new Set(net.vlanRows.map((r) => r.vlanId))].sort((a, b) => a - b);
  const slotOf = new Map(ids.map((id, i) => [id, (i % VLAN_SLOTS) + 1]));
  const key: LinksKeyRow[] = [];
  const seen = new Set<number>();
  for (const row of [...net.vlanRows].sort((a, b) => a.vlanId - b.vlanId)) {
    if (seen.has(row.vlanId)) continue;
    seen.add(row.vlanId);
    key.push({ vlanId: row.vlanId, name: row.name, cidr: row.cidr, slot: slotOf.get(row.vlanId)! });
  }

  const byCable = new Map<string, { ids: Set<number>; trunk: boolean }>();
  for (const row of net.vlanRows) {
    for (const m of row.members) {
      if (m.cableId == null) continue;
      const e = byCable.get(m.cableId) ?? { ids: new Set<number>(), trunk: false };
      e.ids.add(row.vlanId);
      if (m.mode === 'trunk') e.trunk = true;
      byCable.set(m.cableId, e);
    }
  }

  const chassis = new Map([...view.racks.flatMap((r) => r.chassis), ...(view.unplaced ?? [])].map((c) => [c.id, c]));
  const cables = new Map<string, LinksLine>();
  for (const cable of view.cables) {
    let speed: number | null = null;
    for (const end of cable.ends) {
      if (!('portId' in end)) continue;
      const ifaces = edgesIn(doc, end.portId, 'Occupies').map((e) => e.from);
      if (ifaces.length === 0) {
        // A hand-drawn port names its interface by label, as the Routing lens reads it.
        const ch = chassis.get(end.chassisId);
        const label = ch?.ports.find((p) => p.id === end.portId)?.label;
        if (ch != null && label != null) {
          for (const h of edgesOut(doc, ch.deviceId, 'HasInterface')) {
            const name = findNode(doc, h.to)?.fields['Interface.name'];
            if (name?.presence === 'set' && name.value === label) ifaces.push(h.to);
          }
        }
      }
      for (const i of ifaces) {
        const s = speedOf(doc, i);
        if (s != null) speed = speed == null ? s : Math.min(speed, s);
      }
    }
    const v = byCable.get(cable.id);
    const vlans = v == null ? [] : [...v.ids].sort((a, b) => a - b);
    const trunk = v != null && (v.trunk || vlans.length > 1);
    if (vlans.length === 0 && speed == null) continue;
    cables.set(cable.id, { vlans, trunk, slot: !trunk && vlans.length === 1 ? slotOf.get(vlans[0]!)! : null, speedBps: speed });
  }
  return { cables, key };
}
