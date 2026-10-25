// What the Learn layer writes on the drawing (ADR-0066 item 1.2, mockup r4-teach A): a few plain
// notes, each on the first thing of its kind in this design, each opening its explainer. One note
// per idea, never one per device: the drawing teaches the idea once and stays readable.

import type { Explainer } from '../../api/learn';
import type { Document } from '../../document/model';
import { deriveNetworks } from '../../document/networks-derive';
import type { ClosetView } from '../drawing/contract';
import { NOTE_TAB } from './explainers';

export type NoteAnchor = { kind: 'chassis'; id: string } | { kind: 'cable'; id: string };

export interface LearnNote {
  key: string;
  explainerId: string;
  title: string;
  line: string;
  anchor: NoteAnchor;
}

/** Device roles with a note, in the order they are offered: the ideas a small network turns on. */
const ROLE_NOTES: readonly { role: string; subject: string; title: string }[] = [
  { role: 'firewall', subject: 'basics.firewall-zones', title: 'Firewall' },
  { role: 'router', subject: 'basics.router', title: 'Router' },
  { role: 'switch', subject: 'basics.switch', title: 'Switch' },
];

/** At most this many notes on a drawing at once. */
export const MAX_NOTES = 5;

function terse(e: Explainer): string {
  return (e.terse ?? '').replace(/\s+/g, ' ').trim();
}

export function learnNotes(doc: Document | null, view: ClosetView, explainers: readonly Explainer[]): LearnNote[] {
  if (doc == null) return [];
  const bySubject = new Map(explainers.filter((e) => e.tab === NOTE_TAB && e.subject != null).map((e) => [e.subject!, e]));
  const notes: LearnNote[] = [];
  const chassis = [...view.racks.flatMap((r) => r.chassis), ...view.unplaced];

  for (const r of ROLE_NOTES) {
    const e = bySubject.get(r.subject);
    const c = chassis.find((x) => x.role === r.role);
    if (e == null || c == null) continue;
    notes.push({ key: `role:${r.role}`, explainerId: e.id, title: r.title, line: terse(e), anchor: { kind: 'chassis', id: c.id } });
  }

  // Cables: the first trunk and the first access link, with the VLANs they carry.
  const trunk = bySubject.get('basics.trunk');
  const access = bySubject.get('basics.access-port');
  if (trunk != null || access != null) {
    const drawn = new Set(view.cables.map((c) => c.id));
    const byCable = new Map<string, { ids: Set<number>; trunk: boolean }>();
    for (const row of deriveNetworks(doc).vlanRows) {
      for (const m of row.members) {
        if (m.cableId == null || !drawn.has(m.cableId)) continue;
        const e = byCable.get(m.cableId) ?? { ids: new Set<number>(), trunk: false };
        e.ids.add(row.vlanId);
        if (m.mode === 'trunk') e.trunk = true;
        byCable.set(m.cableId, e);
      }
    }
    const ordered = [...byCable].sort(([a], [b]) => a.localeCompare(b));
    const t = ordered.find(([, v]) => v.trunk);
    if (trunk != null && t != null) {
      const ids = [...t[1].ids].sort((x, y) => x - y);
      notes.push({ key: 'trunk', explainerId: trunk.id, title: 'Trunk', line: `carries VLAN${ids.length > 1 ? 's' : ''} ${ids.join(', ')}, tagged`, anchor: { kind: 'cable', id: t[0] } });
    }
    const a = ordered.find(([, v]) => !v.trunk && v.ids.size === 1);
    if (access != null && a != null) {
      notes.push({ key: 'access', explainerId: access.id, title: 'Access port', line: `VLAN ${[...a[1].ids][0]} only, untagged`, anchor: { kind: 'cable', id: a[0] } });
    }
  }
  return notes.slice(0, MAX_NOTES);
}
