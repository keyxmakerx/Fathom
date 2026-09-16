/**
 * Power derivations `docs/UI-SPEC.md` "Power" needs and the rest of the
 * drawing does not have a home for. Pure: no DOM, no React Flow.
 */

import { portKindFor } from './portGlyph';
import type { ChassisView } from './contract';

/** UI-SPEC "Power": "A PDU's outlets are its C13 faceplate ports and its
 * header shows `n of m used`, derived." A PDU is read here as any chassis
 * whose faceplate carries at least one `c13`-glyph port (`portGlyph.ts`'s
 * own alias table reads `c13` as the `c14` glyph — the outlet and the inlet
 * share one glyph at rail scale, UI-SPEC's own "the C14 glyph... at rail
 * scale" for the inlet side) — `undefined` for a chassis that carries none,
 * so a caller never prints a `0 of 0` header on an ordinary device. */
export function pduUsage(chassis: Pick<ChassisView, 'ports'>): { used: number; total: number } | undefined {
  const outlets = chassis.ports.filter((p) => p.connector.trim().toLowerCase() === 'c13');
  if (outlets.length === 0) return undefined;
  const used = outlets.filter((p) => p.cable != null).length;
  return { used, total: outlets.length };
}

/** UI-SPEC "Power": "n of m used" — the PDU header's own words, never a
 * bare fraction. */
export function pduUsageLabel(usage: { used: number; total: number }): string {
  return `${usage.used} of ${usage.total} used`;
}

/** True when a port is the c13/c14 kind either derivation above resolves —
 * shared so `RackNode.tsx`'s rail hexagons and any future PDU faceplate
 * treatment read the same connector test `portGlyph.ts` already applies. */
export function isPowerConnector(connector: string): boolean {
  return portKindFor(connector) === 'c14';
}
