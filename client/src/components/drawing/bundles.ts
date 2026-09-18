/**
 * Grouping cables into the bands `docs/UI-SPEC.md` "Keeping it readable at
 * forty cables" #1 draws: "cables sharing both ends draw as one band whose
 * width grows with the count and carries a `×n` badge." Pure: no DOM, no
 * React Flow — `Drawing.tsx`/`CableEdge.tsx` turn a `Bundle` into the band
 * and its fanned-out members.
 *
 * "Sharing both ends" is read as the same two chassis AND the same cable
 * kind — a copper run and a power lead between the same two boxes never
 * share a band, because they never share a lane (`geometry.ts`'s
 * `laneBiasPx`: "power keeps its own lane on the other side from data").
 * Only a cable with two real (chassis-mounted) ends can bundle at all: one
 * with an outside end has nothing on the far side to share, and a
 * one-ended cable (`CableView.ends.length < 2`, 19 §3.4) is drawn alone —
 * `document/view.ts`'s own file header on `CableEnd`.
 */

import type { CableView } from './contract';

export interface Bundle {
  /** Stable across renders for the same (chassisA, chassisB, kind) — the
   * caller's React key and the band edge's own id. Unordered: `chassisA`
   * and `chassisB` are sorted so a bundle from A→B and one recorded B→A
   * (cable end order is not itself meaningful) land in the same group. */
  key: string;
  chassisA: string;
  chassisB: string;
  kind: CableView['kind'];
  /** Every cable in the bundle, in `fanOrder` — the order the fanned-out
   * view lays them out in, and the order the `×n` badge counts. */
  members: readonly CableView[];
}

function realChassisEnds(cable: CableView): [string, string] | null {
  const real = cable.ends.filter((e): e is { portId: string; chassisId: string; rackId: string | null } => 'portId' in e);
  if (real.length !== 2) return null;
  return [real[0].chassisId, real[1].chassisId];
}

/** The fanned-out reading order — UI-SPEC #2: "each with its own sheath and
 * its port pair labelled." Sorted by the cable's own near/far port ids
 * (the only per-member identity `bundles.ts` itself has cheap access to;
 * `Drawing.tsx`/`CableEdge.tsx` resolve those ids to the port *labels* the
 * fanned view actually shows) — cable id as the final tiebreak, so the
 * order is total and stable even if two members' ports were somehow equal.
 */
export function fanOrder(members: readonly CableView[]): CableView[] {
  const portKeyOf = (cable: CableView): string => {
    const real = cable.ends.filter((e): e is { portId: string; chassisId: string; rackId: string | null } => 'portId' in e);
    return real.map((e) => e.portId).sort().join('|');
  };
  return [...members].sort((a, b) => portKeyOf(a).localeCompare(portKeyOf(b)) || a.id.localeCompare(b.id));
}

/** Every bundle a view's cables form, including a bundle of one (a plain,
 * unbanded cable) so a caller can treat every cable uniformly by looking it
 * up here rather than branching on "is this cable bundled." Only a
 * `members.length > 1` bundle draws as a band; `Drawing.tsx` decides that. */
export function groupBundles(cables: readonly CableView[]): Bundle[] {
  const groups = new Map<string, { key: string; chassisA: string; chassisB: string; kind: CableView['kind']; members: CableView[] }>();

  for (const cable of cables) {
    const ends = realChassisEnds(cable);
    if (!ends) continue;
    const [a, b] = [...ends].sort();
    const key = `${a}|${b}|${cable.kind}`;
    const existing = groups.get(key);
    if (existing) {
      existing.members.push(cable);
    } else {
      groups.set(key, { key, chassisA: a, chassisB: b, kind: cable.kind, members: [cable] });
    }
  }

  return [...groups.values()].map((g) => ({ ...g, members: fanOrder(g.members) }));
}

/** The bundle a given cable belongs to, or `undefined` for a cable with an
 * outside or missing end (never bundled, `groupBundles`'s own filter). */
export function bundleFor(bundles: readonly Bundle[], cableId: string): Bundle | undefined {
  return bundles.find((b) => b.members.some((m) => m.id === cableId));
}
