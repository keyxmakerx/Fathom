/** What the Show layers write on the Diagram look, read off the design alone
 * (no new field). Pure; the derivations are memoised on the Document. */

import type { Document } from '../../document/model';
import { deriveNetworks } from '../../document/networks-derive';
import { docsOf } from '../../document/docs';
import { listPlans } from '../../document/plans';
import { buildCanon } from '../checks/checksModel';
import { touchedDevices } from '../plans/plansModel';
import { tagsOf } from '../../document/tags';
import type { ClosetView } from './contract';
import { layerOn, type LayerSet } from './layers';
import type { Rect } from './diagram';

export interface CableWords {
  /** One address per end, nearest the port. */
  a?: string;
  b?: string;
  /** "VLAN 20" or "TRUNK 10,20,30", mid-line. */
  mid?: string;
}

export interface LayerWords {
  cables: Map<string, CableWords>;
  /** Plain text under a device, keyed by chassis id. */
  devices: Map<string, string[]>;
}

const EMPTY: LayerWords = { cables: new Map(), devices: new Map() };

/** "10.0.20.1/24" reads "10.0.20.1" on the drawing. */
function hostOnly(a: string): string {
  const i = a.indexOf('/');
  return i < 0 ? a : a.slice(0, i);
}

export function vlanWord(ids: number[], trunk: boolean): string {
  const s = [...new Set(ids)].sort((x, y) => x - y);
  return trunk && s.length > 1 ? `TRUNK ${s.join(',')}` : `VLAN ${s.join(',')}`;
}

export function layerWords(doc: Document | null, view: ClosetView, layers: LayerSet): LayerWords {
  if (doc == null) return EMPTY;
  const wantAddr = layerOn(layers, 'addresses');
  const wantVlan = layerOn(layers, 'vlans');
  const wantTags = layerOn(layers, 'tags');
  const wantDocs = layerOn(layers, 'docs');
  const wantMaint = layerOn(layers, 'maintenance');
  if (!wantAddr && !wantVlan && !wantTags && !wantDocs && !wantMaint) return EMPTY;
  const cables = new Map<string, CableWords>();
  const devices = new Map<string, string[]>();

  if (wantAddr || wantVlan) {
    const net = deriveNetworks(doc);
    if (wantVlan) {
      const byCable = new Map<string, { ids: number[]; trunk: boolean }>();
      for (const row of net.vlanRows) {
        for (const m of row.members) {
          if (m.cableId == null) continue;
          const e = byCable.get(m.cableId) ?? { ids: [], trunk: false };
          e.ids.push(row.vlanId);
          if (m.mode === 'trunk') e.trunk = true;
          byCable.set(m.cableId, e);
        }
      }
      for (const [id, e] of byCable) cables.set(id, { mid: vlanWord(e.ids, e.trunk) });
    }
    if (wantAddr) {
      // device + port label -> address, from both row kinds
      const addr = new Map<string, string>();
      for (const row of net.vlanRows) for (const m of row.members) if (m.address != null) addr.set(`${m.deviceId}|${m.interfaceLabel}`, hostOnly(m.address));
      for (const row of net.subnetRows) for (const m of row.members) addr.set(`${m.deviceId}|${m.interfaceLabel}`, hostOnly(m.address));
      const chassisById = new Map(view.racks.flatMap((r) => r.chassis).map((c) => [c.id, c]));
      for (const cable of view.cables) {
        const ends = cable.ends.filter((e): e is { portId: string; chassisId: string; rackId: string | null } => 'portId' in e);
        if (ends.length !== 2) continue;
        const text = ends.map((e) => {
          const ch = chassisById.get(e.chassisId);
          const port = ch?.ports.find((p) => p.id === e.portId);
          return ch != null && port != null ? addr.get(`${ch.deviceId}|${port.label}`) : undefined;
        });
        if (text[0] == null && text[1] == null) continue;
        cables.set(cable.id, { ...cables.get(cable.id), a: text[0], b: text[1] });
      }
    }
  }

  // Devices an unrecorded plan touches: 'doing' wins over 'planned'.
  const planned = new Map<string, string>();
  if (wantMaint) {
    const canon = buildCanon(doc);
    for (const plan of listPlans(doc)) {
      if (plan.stage === 'recorded') continue;
      const word = plan.stage === 'doing' ? 'doing' : 'planned';
      for (const d of touchedDevices(doc, canon, plan)) if (planned.get(d.id) !== 'doing') planned.set(d.id, word);
    }
  }

  if (wantTags || wantDocs || wantMaint) {
    for (const ch of view.racks.flatMap((r) => r.chassis)) {
      const words: string[] = [];
      const plan = planned.get(ch.deviceId);
      if (plan != null) words.push(plan);
      if (wantDocs && docsOf(doc, ch.deviceId, ch.model).length > 0) words.push('docs');
      if (wantTags) words.push(...tagsOf(doc, ch.deviceId).map((t) => t.name));
      if (words.length > 0) devices.set(ch.id, words);
    }
  }
  return { cables, devices };
}

export interface PlacedLabel {
  key: string;
  text: string;
  x: number;
  y: number;
  /** Anchor: which side of (x, y) the text sits on. */
  ax: 'start' | 'middle' | 'end';
  /** Hidden labels that lost the spot to this one. */
  more: number;
}

export interface Candidate {
  key: string;
  text: string;
  x: number;
  y: number;
  ax: 'start' | 'middle' | 'end';
  /** Lower wins. */
  priority: number;
}

const CHAR_W = 7.5;
const LABEL_H = 18;

/** `scale` is flow units per screen pixel (1 / zoom): labels keep one on-screen size. */
function rectOf(c: Candidate, scale: number): Rect {
  // 3 spare characters: the " +n" a winner may grow by.
  const w = ((c.text.length + 3) * CHAR_W + 8) * scale;
  const x = c.ax === 'start' ? c.x : c.ax === 'end' ? c.x - w : c.x - w / 2;
  return { x, y: c.y - (LABEL_H / 2) * scale, w, h: LABEL_H * scale };
}

function hit(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Greedy by priority: a label that would overlap one already placed, or a box, is hidden and counted as "+n" on the label it lost to. */
export function placeLabels(cands: readonly Candidate[], boxes: readonly Rect[], scale = 1): PlacedLabel[] {
  const sorted = [...cands].sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
  const placed: Array<{ label: PlacedLabel; rect: Rect }> = [];
  for (const c of sorted) {
    const r = rectOf(c, scale);
    if (boxes.some((b) => hit(r, b))) continue;
    const clash = placed.find((p) => hit(p.rect, r));
    if (clash) {
      clash.label.more += 1;
      continue;
    }
    placed.push({ label: { key: c.key, text: c.text, x: c.x, y: c.y, ax: c.ax, more: 0 }, rect: r });
  }
  return placed.map((p) => p.label);
}

const PRIORITY = { mid: 0, end: 1 } as const;

/** Label spots for every cable that has words: addresses at the port ends, the VLAN word mid-line. */
export function cableCandidates(
  routes: ReadonlyArray<{ id: string; route: { a: Pt4; b: Pt4 } }>,
  words: ReadonlyMap<string, CableWords>,
  scale: number,
): Candidate[] {
  const out: Candidate[] = [];
  const gap = 6 * scale;
  const spot = (p: Pt4, k: number) => {
    // Beside a vertical run, above a horizontal one, a little way out from the box.
    const run = k * scale;
    if (p.dx === 0) return { x: p.x + gap, y: p.y + p.dy * (run + 9 * scale), ax: 'start' as const };
    return { x: p.x + p.dx * run, y: p.y - 10 * scale, ax: p.dx > 0 ? ('start' as const) : ('end' as const) };
  };
  for (const { id, route } of routes) {
    const w = words.get(id);
    if (w == null) continue;
    if (w.mid != null) {
      const mx = (route.a.x + route.b.x) / 2;
      const my = (route.a.y + route.b.y) / 2;
      const straightH = route.a.y === route.b.y;
      // Straight vertical or bent: beside the vertical run; straight horizontal: above it. Never on the line.
      if (straightH) out.push({ key: `${id}:mid`, text: w.mid, x: mx, y: my - 10 * scale, ax: 'middle', priority: PRIORITY.mid });
      else out.push({ key: `${id}:mid`, text: w.mid, x: mx + gap, y: my, ax: 'start', priority: PRIORITY.mid });
    }
    if (w.a != null) out.push({ key: `${id}:a`, text: w.a, ...spot(route.a, 8), priority: PRIORITY.end });
    if (w.b != null) out.push({ key: `${id}:b`, text: w.b, ...spot(route.b, 8), priority: PRIORITY.end });
  }
  return out;
}

interface Pt4 {
  x: number;
  y: number;
  dx: number;
  dy: number;
}
