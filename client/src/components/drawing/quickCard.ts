// What the quick card says about the thing just clicked (from Key Maker's note of 31 October): its kind, its
// name, and the management address on its own line so it can be copied. The rest is the hover peek's rows
// (`thingPeek.ts`), so the two never disagree. Pure; the card is `QuickCard.tsx`.

import type { ClosetView } from './contract';
import { findChassis, findUnplacedChassis } from './lookup';
import { thingPeek, type PeekTarget, type ThingRow } from './thingPeek';

export interface QuickCardFacts {
  /** What kind of thing it is, in words: "Switch", "Access point", "Device" when no role is set, "Rack". */
  kind: string;
  title: string;
  /** The management address, or null when there is none to copy. */
  address: string | null;
  /** The peek's other rows; the address is not among them. */
  rows: ThingRow[];
  /** A device can be opened inside with a double-click; the card says so. */
  opens: boolean;
}

const KIND_WORD: Record<Exclude<PeekTarget['kind'], 'device'>, string> = { rack: 'Rack', shelf: 'Shelf', cable: 'Cable' };

/** "access_point" -> "Access point". */
export function roleWord(role: string | null | undefined): string {
  const words = (role ?? '').replace(/_/g, ' ').trim();
  return words === '' ? 'Device' : words.charAt(0).toUpperCase() + words.slice(1);
}

function deviceFacts(view: ClosetView, id: string): { role: string | null; address: string | null } {
  const chassis = findChassis(view, id)?.chassis ?? findUnplacedChassis(view, id);
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
  return { kind: roleWord(role), title: peek.title, address: trimmed !== '' ? trimmed : null, rows, opens: true };
}
