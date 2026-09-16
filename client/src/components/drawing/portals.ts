/**
 * Grouping cables that leave the closet into the portal trays that draw
 * them — `docs/UI-SPEC.md` "Portals": "the cable visibly sags to the edge
 * of the view and ends in a dashed tray there, naming where it goes and how
 * many cross," "above or below the rack... decide by the port's row." Pure:
 * no DOM, no React Flow — the caller (`Drawing.tsx`) turns each `PortalGroup`
 * into a tray node and routes every cable in it there.
 */

import type { CableKind, CableView, ClosetView } from './contract';
import { portalTraySide } from './geometry';

export interface PortalGroup {
  /** Stable across renders for the same (rack, side, far label) — the
   * caller's React key and tray node id. */
  key: string;
  rackId: string;
  side: 'above' | 'below';
  /** The far side's own name, as the cable's outside end carries it —
   * "up the riser → MDF A-01." Never invented; grouped only with another
   * cable that names the exact same place. */
  label: string;
  /** Every cable crossing to this tray, near-end first. */
  cables: ReadonlyArray<{ cableId: string; kind: CableKind; nearPortId: string }>;
}

/** "naming... how many cross" as the approved board phrases it — "3 fibre
 * · 1 copper" — one count per kind present, in a fixed reading order, never
 * a bare total that hides what is actually crossing. */
export function portalCountLabel(group: Pick<PortalGroup, 'cables'>): string {
  const order: CableKind[] = ['fibre', 'copper', 'power'];
  const counts = new Map<CableKind, number>();
  for (const c of group.cables) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  return order
    .filter((kind) => counts.has(kind))
    .map((kind) => `${counts.get(kind)} ${kind}`)
    .join(' · ');
}

/** The one real end of a cable that has an `outside` end, and that end's
 * label — `undefined` for a cable that does not leave the closet (both ends
 * real) or that has no real end at all (never produced by a real document,
 * but not this function's place to assume that). */
function outsideEndOf(cable: CableView): { nearPortId: string; nearChassisId: string; label: string } | undefined {
  const outside = cable.ends.find((e): e is { outside: true; label: string } => 'outside' in e && e.outside);
  if (!outside) return undefined;
  const near = cable.ends.find((e): e is { portId: string; chassisId: string; rackId: string } => 'portId' in e);
  if (!near) return undefined;
  return { nearPortId: near.portId, nearChassisId: near.chassisId, label: outside.label };
}

export function groupPortals(view: ClosetView): PortalGroup[] {
  const groups = new Map<string, PortalGroup & { cables: Array<{ cableId: string; kind: CableKind; nearPortId: string }> }>();

  for (const cable of view.cables ?? []) {
    const outside = outsideEndOf(cable);
    if (!outside) continue;

    let rackId: string | undefined;
    let side: 'above' | 'below' | undefined;
    for (const rack of view.racks) {
      const chassis = rack.chassis.find((c) => c.id === outside.nearChassisId);
      if (chassis) {
        rackId = rack.id;
        side = portalTraySide(rack.heightU, chassis.positionU);
        break;
      }
    }
    // The near end names a chassis this view does not carry — a stale or
    // cross-closet reference. Nothing to anchor a tray to, so this cable is
    // skipped rather than drawn floating (UI-SPEC "Portals": never a cable
    // off the edge with no tray, and never a tray with nothing reaching it).
    if (rackId == null || side == null) continue;

    const key = `${rackId}|${side}|${outside.label}`;
    const existing = groups.get(key);
    const entry = { cableId: cable.id, kind: cable.kind, nearPortId: outside.nearPortId };
    if (existing) {
      existing.cables.push(entry);
    } else {
      groups.set(key, { key, rackId, side, label: outside.label, cables: [entry] });
    }
  }

  return [...groups.values()];
}
