/**
 * Power derivations `docs/UI-SPEC.md` "Power" needs and the rest of the
 * drawing does not have a home for. Pure: no DOM, no React Flow.
 */

import { portKindFor } from './portGlyph';
import type { ChassisView, InletView } from './contract';

/** `PhysicalPort.connector` tokens read as a PDU's own outlet, not a
 * device's inlet — schema 0.8 (ADR-0051 §1, `schema/schema.yaml`'s own
 * changelog note) adds `nema515r`/`nema515p` beside `c13`/`c14`: the same
 * IEC/NEMA outlet-and-plug pairing, mains flavour, for a tower UPS's own
 * receptacle strip (`design/places/renders/Surfaces.png`'s `ups-01`, "3 of
 * 4 out"). `nema515p` is the PLUG side (a device's own inlet, like `c14`)
 * and deliberately not read here — only the receptacle/outlet spelling
 * counts toward a PDU-shaped header, the same asymmetry `c13`/`c14`
 * already keeps. */
const OUTLET_CONNECTORS = new Set(['c13', 'nema515r']);

/** UI-SPEC "Power": "A PDU's outlets are its C13 faceplate ports and its
 * header shows `n of m used`, derived." A PDU is read here as any chassis
 * whose faceplate carries at least one outlet-glyph port (`OUTLET_CONNECTORS`
 * above; `portGlyph.ts`'s own alias table reads every one of them as the
 * `c14` glyph — the outlet and the inlet share one glyph at rail scale,
 * UI-SPEC's own "the C14 glyph... at rail scale" for the inlet side) —
 * `undefined` for a chassis that carries none, so a caller never prints a
 * `0 of 0` header on an ordinary device. */
export function pduUsage(chassis: Pick<ChassisView, 'ports'>): { used: number; total: number } | undefined {
  const outlets = chassis.ports.filter((p) => OUTLET_CONNECTORS.has(p.connector.trim().toLowerCase()));
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

/** ADR-0050 §4's own rule ("two or more FITTED inlets and exactly one of
 * them cabled"), `document/view.ts`'s `chassisView` own arithmetic —
 * mirrored here, not imported (that file is off limits this session), so
 * `SurfaceNode.tsx` can apply the SAME rule to a `FixtureView.psuInlets`
 * (`design/places/renders/Surfaces.png`, ADR-0051 §1/§2 — a fixture draws
 * single-fed and one-fitted washes the same way a chassis does): a fixture's
 * own `psuInlets` is the identical
 * `InletView[]` shape a rack chassis's own is, ADR-0051 §1's `FixtureView`
 * doc; a `FixtureView` simply carries no precomputed `singleFed`/`oneFitted`
 * bit of its own the way `ChassisView` does, so this session derives it). */
export function isSingleFed(inlets: readonly Pick<InletView, 'fitted' | 'cable'>[]): boolean {
  const fitted = inlets.filter((i) => i.fitted);
  const fed = fitted.filter((i) => i.cable != null);
  return fitted.length >= 2 && fed.length === 1;
}

/** ADR-0050 §4's other half: "two or more PSU slots and at least one of
 * them is empty" — same mirrored rule as `isSingleFed` above. */
export function isOneFitted(inlets: readonly Pick<InletView, 'fitted'>[]): boolean {
  return inlets.length >= 2 && inlets.some((i) => !i.fitted);
}
