// What the quick card says about the thing just clicked (from Key Maker's note of 31 October): its kind, its
// name, and the management address on its own line so it can be copied. The rest is the hover peek's rows
// (`thingPeek.ts`), so the two never disagree. Pure; the card is `QuickCard.tsx`.

import type { ClosetView } from './contract';
import { findDevice, findFixture } from './lookup';
import type { Document } from '../../document/model';
import { portPeek } from './portPeek';
import { thingPeek, type PeekTarget, type ThingRow } from './thingPeek';

export interface QuickCardFacts {
  /** What kind of thing it is, in words: "Switch", "Access point", "Device" when no role is set, "Rack". */
  kind: string;
  title: string;
  /** The management address, or null when there is none to copy. */
  address: string | null;
  /** The peek's other rows; the address is not among them. */
  rows: ThingRow[];
  /** A device in a rack, on a shelf or not placed yet opens inside with a double-click; the card says so. */
  opens: boolean;
}

const KIND_WORD: Record<Exclude<PeekTarget['kind'], 'device'>, string> = { rack: 'Rack', shelf: 'Shelf', cable: 'Cable' };

/** "access_point" -> "Access point". */
export function roleWord(role: string | null | undefined): string {
  const words = (role ?? '').replace(/_/g, ' ').trim();
  return words === '' ? 'Device' : words.charAt(0).toUpperCase() + words.slice(1);
}

function deviceFacts(view: ClosetView, id: string): { role: string | null; address: string | null } {
  // Wherever it sits: in a rack, on a shelf, on a wall, or not placed yet.
  const chassis = findDevice(view, id)?.chassis;
  if (chassis != null) return { role: chassis.role, address: chassis.managementAddress };
  const box = view.free.find((f) => f.id === id);
  return { role: box?.role ?? null, address: null };
}

export function quickCard(view: ClosetView, target: PeekTarget): QuickCardFacts | null {
  const peek = thingPeek(view, target);
  if (peek == null) return null;
  const rows = peek.rows.filter((r) => r.key !== 'Address');
  if (target.kind !== 'device') return { kind: KIND_WORD[target.kind], title: peek.title, address: null, rows, opens: false };
  const { role, address } = deviceFacts(view, target.id);
  const trimmed = address?.trim() ?? '';
  // A double-click does not open a device on a wall, so its card does not say that it does.
  const opens = findFixture(view, target.id) == null;
  return { kind: roleWord(role), title: peek.title, address: trimmed !== '' ? trimmed : null, rows, opens };
}

/** r116: the card for a clicked port, from the port peek's own rows (`portPeek.ts`), so the two never disagree. */
export function quickPortCard(doc: Document | null, view: ClosetView, portId: string): QuickCardFacts | null {
  const peek = portPeek(doc, view, portId);
  if (peek == null) return null;
  return { kind: 'Port', title: peek.title, address: null, rows: peek.rows, opens: false };
}
