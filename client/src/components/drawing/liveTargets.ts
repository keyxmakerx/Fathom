/**
 * Which ports stay live while a lead is in hand — `docs/UI-SPEC.md`
 * "Cables": "Only compatible ports stay live during a drag; the rest dim,"
 * and "One cable per port": an already-cabled port is never a target. Pure:
 * a `ClosetView` and a port id in, a set of port ids out — no DOM, no React
 * Flow, so `Drawing.tsx`'s drag handling can be exercised without either.
 */

import { compatible } from '../../document/compat';
import type { ClosetView } from './contract';
import { findPort } from './lookup';

/**
 * Every port in `view` that a drag started from `fromPortId` may legally
 * end on: not the origin itself, not already cabled, and `compatible` with
 * the origin's own connector. Empty if `fromPortId` names nothing in this
 * view or is itself already cabled — starting a second cable from a full
 * port is not this session's feature (UI-SPEC "One cable per port").
 */
export function liveTargetPortIds(view: ClosetView, fromPortId: string): Set<string> {
  const from = findPort(view, fromPortId);
  const live = new Set<string>();
  if (!from || (from.port.cable ?? null) != null) return live;

  for (const rack of view.racks) {
    for (const chassis of rack.chassis) {
      for (const port of chassis.ports) {
        if (port.id === fromPortId) continue;
        if ((port.cable ?? null) != null) continue;
        if (compatible(from.port.connector, port.connector).ok) live.add(port.id);
      }
    }
  }
  return live;
}
