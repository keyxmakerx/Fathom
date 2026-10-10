// What the port peek card says: pointing at a port shows where it goes, which VLAN it carries and which
// cable is plugged in. Read from the design as it already is (the view, the networks derivation, the
// cables); nothing new is stored. Pure; the card is `PortPeek.tsx`.

import type { Document } from '../../document/model';
import { deriveNetworks } from '../../document/networks-derive';
import { deviceNameIndex } from './cableGroups';
import type { ClosetView } from './contract';
import { locatePort } from './lookup';

export interface PeekRow {
  key: 'To' | 'VLAN' | 'Cable';
  value: string;
  /** Says there is nothing here ("Not connected"): drawn in the muted ink. */
  empty: boolean;
}

export interface PortPeekCard {
  /** The port's own label, e.g. "ge-0/0/1". */
  title: string;
  rows: PeekRow[];
}

/** More VLANs than this on a trunk read "+3 more". */
const TRUNK_SHOWN = 6;

export function portPeek(doc: Document | null, view: ClosetView, portId: string): PortPeekCard | null {
  const found = locatePort(view, portId);
  if (found == null) return null;
  const port = found.port;
  const title = ('slot' in port && typeof port.slot === 'string' && port.slot !== '' ? port.slot : port.label) || 'Port';
  const end = port.cable ?? null;
  const cable = end != null ? (view.cables ?? []).find((c) => c.id === end.cableId) : undefined;
  return {
    title,
    rows: [
      { key: 'To', ...toRow(view, end, cable) },
      { key: 'VLAN', ...vlanRow(doc, end?.cableId ?? null, port.label) },
      { key: 'Cable', ...cableRow(end != null, cable) },
    ],
  };
}

function toRow(view: ClosetView, end: { farPortId: string | null; farChassisId: string | null; outsideCloset: boolean } | null, cable: ClosetView['cables'][number] | undefined): { value: string; empty: boolean } {
  if (end == null) return { value: 'Not connected', empty: true };
  if (end.outsideCloset || end.farPortId == null) {
    const outside = cable?.ends.find((e): e is { outside: true; label: string } => 'outside' in e);
    return { value: outside != null && outside.label !== '' ? outside.label : 'Leaves this room', empty: false };
  }
  const device = end.farChassisId != null ? deviceNameIndex(view).get(end.farChassisId) : undefined;
  const far = locatePort(view, end.farPortId)?.port;
  const farLabel = far == null ? '' : ('slot' in far && typeof far.slot === 'string' && far.slot !== '' ? far.slot : far.label);
  const text = [device, farLabel].filter((s): s is string => s != null && s !== '').join(' · ');
  return text === '' ? { value: 'Not connected', empty: true } : { value: text, empty: false };
}

function cableRow(cabled: boolean, cable: ClosetView['cables'][number] | undefined): { value: string; empty: boolean } {
  if (!cabled) return { value: 'No cable', empty: true };
  if (cable == null) return { value: 'Cable', empty: false };
  const name = (cable.label ?? '').trim() !== '' ? cable.label!.trim() : cable.media !== '' ? cable.media : 'Unlabelled';
  const length = cable.lengthM != null ? `${cable.lengthM} m` : null;
  return { value: [name, length].filter((s): s is string => s != null).join(' · '), empty: false };
}

/** "20 Staff" for a port that carries one VLAN untagged, "Trunk 10, 20, 30" for one that carries several. The
 * networks derivation names a VLAN by the cable and port label it travels over. */
function vlanRow(doc: Document | null, cableId: string | null, portLabel: string): { value: string; empty: boolean } {
  const none = { value: 'No VLAN', empty: true };
  if (doc == null || cableId == null) return none;
  const onCable = deriveNetworks(doc).vlanRows.flatMap((row) => row.members.filter((m) => m.cableId === cableId).map((m) => ({ row, m })));
  // Both ends of a cable are members; this port's own end is the one whose interface carries its label.
  const mine = onCable.filter(({ m }) => m.interfaceLabel === portLabel);
  const picked = mine.length > 0 ? mine : onCable;
  if (picked.length === 0) return none;
  const access = new Map<number, string>();
  const trunk = new Set<number>();
  for (const { row, m } of picked) {
    if (m.mode === 'trunk') trunk.add(row.vlanId);
    else access.set(row.vlanId, row.name != null && row.name !== '' ? `${row.vlanId} ${row.name}` : String(row.vlanId));
  }
  const parts: string[] = [];
  if (access.size > 0) parts.push([...access.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join(', '));
  if (trunk.size > 0) {
    const ids = [...trunk].sort((a, b) => a - b);
    const shown = ids.slice(0, TRUNK_SHOWN).join(', ');
    parts.push(`Trunk ${shown}${ids.length > TRUNK_SHOWN ? ` +${ids.length - TRUNK_SHOWN} more` : ''}`);
  }
  return { value: parts.join(' · '), empty: false };
}
