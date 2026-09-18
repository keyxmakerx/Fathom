/**
 * Which ports stay live while a lead is in hand — `docs/UI-SPEC.md`
 * "Cables": "Only compatible ports stay live during a drag; the rest dim,"
 * and "One cable per port": an already-cabled port is never a target. Pure:
 * a `ClosetView` and a port id in, a set of port ids out — no DOM, no React
 * Flow, so `Drawing.tsx`'s drag handling can be exercised without either.
 */

import { compatible } from '../../document/compat';
import type { ClosetView, PortView } from './contract';
// `FixtureView` is ADR-0051 §1's own new shape — read straight off
// `document/view.ts`, the one place it is declared, for the same reason
// `lookup.ts`'s own file header gives: `./contract.ts` (off limits this
// session) has not widened its re-export list to carry it yet.
import type { FixtureView } from '../../document/view';
import { locatePort } from './lookup';

/**
 * Every port in `view` that a drag started from `fromPortId` may legally
 * end on: not the origin itself, not already cabled, and `compatible` with
 * the origin's own connector. Empty if `fromPortId` names nothing in this
 * view or is itself already cabled — starting a second cable from a full
 * port is not this session's feature (UI-SPEC "One cable per port").
 *
 * ADR-0051 §1/§2 — searched everywhere a port can actually be: a rack
 * chassis's own faceplate, a shelf occupant's, and a surface fixture's
 * (a board's own nested fixtures included) — `locatePort`, not `findPort`,
 * for the origin lookup, and every one of the three places walked below, so
 * a drag started on a shelf occupant or a surface fixture lights its own
 * compatible targets exactly as one started on a rack chassis already does.
 */
export function liveTargetPortIds(view: ClosetView, fromPortId: string): Set<string> {
  const from = locatePort(view, fromPortId);
  const live = new Set<string>();
  if (!from || (from.port.cable ?? null) != null) return live;

  function consider(port: PortView): void {
    if (port.id === fromPortId) return;
    if ((port.cable ?? null) != null) return;
    if (compatible(from!.port.connector, port.connector).ok) live.add(port.id);
  }

  function walkFixtures(fixtures: readonly FixtureView[]): void {
    for (const fixture of fixtures) {
      fixture.ports.forEach(consider);
      walkFixtures(fixture.fixtures);
    }
  }

  for (const rack of view.racks) {
    for (const chassis of rack.chassis) chassis.ports.forEach(consider);
    for (const shelf of rack.shelves ?? []) {
      for (const occupant of shelf.occupants) occupant.ports.forEach(consider);
    }
  }
  for (const surface of view.surfaces ?? []) walkFixtures(surface.fixtures);

  return live;
}
