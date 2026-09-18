/**
 * Lighting the whole physical path — `docs/UI-SPEC.md` "Keeping it readable
 * at forty cables" #3: "hover any segment and the entire physical run
 * lights in order, through panels and risers to the portal. A cable is a
 * path, not a line." Pure: a `ClosetView` (plus the portal groups
 * `portals.ts` already derives) and a starting cable id in, an ordered list
 * of cable ids and the portal trays the path reaches out.
 *
 * Two assumptions this session had to make without a schema field to read
 * them off, both recorded here rather than silently baked in:
 *
 * 1. **What counts as a panel.** `ClosetView`/`ChassisView` (`contract.ts`,
 *    re-exported from `document/view.ts`) carry no catalogue "kind" enum —
 *    `api/catalogue.ts`'s `CatalogueModel` is vendor/model/rackUnits/
 *    reviewedBy/source/psuInlets/faceplates, nothing that says "this model
 *    is a patch panel." Nor can a panel be a schema `PassiveNode`: the only
 *    edge that racks a box, `MountedIn`, is `from: [Chassis]`
 *    (`schema/schema.yaml`), so anything this drawing can place in a rack
 *    is already a `Chassis`-backed `ChassisView`, `PassiveNode` or not.
 *    `isPanel` below reads a chassis with an empty `psuInlets` (no PSU
 *    inlets known to the catalogue — `cables.ts`'s `placeChassis` only adds
 *    them when `model.psuInlets` is set) as unpowered, i.e. a panel — the
 *    same distinction `Main.dc.html`'s own rack draws visually (patch-01
 *    and fibre-01 are the only two rows with no bullet and a grey header,
 *    every powered device around them has both). A device the catalogue
 *    simply has no PSU data for would misread as a panel under this rule;
 *    flagged for the lead rather than guessed past.
 * 2. **How a panel's ports pair — SUPERSEDED by ADR-0051 §1.** A panel port
 *    carries at most one cable (`PhysicalPort` — one cable per port,
 *    `liveTargets.ts`'s own doc), so "the cable on the panel's paired port"
 *    needs a second port to be *this* port's continuation. ADR-0051 §1: "A
 *    panel's or outlet's pairing is written as the schema's `PassThrough`
 *    edge at placement" — a real edge now exists for exactly this, and
 *    `PortView.passThroughId` (`document/view.ts`'s own doc on the field) is
 *    the id of the live `PassThrough` EDGE, not a port id — `PassThrough` is
 *    symmetric, so `document/view.ts` resolves the SAME edge, and so the
 *    SAME id, from either port it joins. The far port is therefore "whatever
 *    other port in this view carries that same `passThroughId`," found by
 *    `portByPassThroughId` below rather than by treating the edge id as if
 *    it named a port directly (`findPort(view, port.passThroughId)` would
 *    look up an edge id in a table of port ids and never match). The walk
 *    below (`pairedPortFor`) reads that field FIRST, view-wide (a
 *    `PassThrough`'s far port need not sit on the same chassis — an outlet
 *    box's own front/rear, or a splitter's several legs, are not guaranteed
 *    to be). The OLD same-chassis, same-label, different-row guess
 *    (`pairedPort`, kept below unchanged) now only fires when
 *    `passThroughId` is `null` — a document written, or a faceplate
 *    matched, before this session's placement command started setting it.
 *    Nothing here reads a panel's paired port off the mere ABSENCE of a
 *    `passThroughId` value as if that absence were itself a fact about the
 *    panel; a `null` is read as "not yet known," never as "not paired."
 */

import type { CableView, ChassisView, ClosetView, PortView } from './contract';
import { findPort } from './lookup';
import type { PortalGroup } from './portals';

type RealEnd = { portId: string; chassisId: string; rackId: string };

function isRealEnd(end: CableView['ends'][number]): end is RealEnd {
  return 'portId' in end;
}

function realEnds(cable: CableView): RealEnd[] {
  return cable.ends.filter(isRealEnd);
}

function outsideLabel(cable: CableView): string | undefined {
  const end = cable.ends.find((e): e is { outside: true; label: string } => 'outside' in e && e.outside);
  return end?.label;
}

/** See the file header, assumption 1. */
export function isPanel(chassis: Pick<ChassisView, 'psuInlets'>): boolean {
  return chassis.psuInlets.length === 0;
}

/** See the file header, assumption 2 — the FALLBACK reading, same-chassis,
 * same label, different row. `undefined` when there is no such second port
 * (an ordinary single-row faceplate, or nothing else cabled). Never called
 * directly by `extend` below any more; `pairedPortFor` calls it only once
 * `port.passThroughId` has already been read and found `null`. */
export function pairedPort(
  chassis: Pick<ChassisView, 'ports'>,
  port: Pick<PortView, 'id' | 'label' | 'row'>,
): PortView | undefined {
  return chassis.ports.find((p) => p.id !== port.id && p.label === port.label && p.label !== '' && p.row !== port.row);
}

/** `port.passThroughId`'s own EDGE id, resolved to the other port carrying
 * that same id — `document/view.ts`'s `passThroughIdOf` reads a symmetric
 * `PassThrough` edge from either of the two ports it joins, so both come
 * back with the identical edge id, never each other's port id. Searched
 * VIEW-WIDE (every rack's every chassis, not just `chassis.ports`), since a
 * `PassThrough`'s far port need not sit on the near port's own chassis. A
 * `passThroughId` this view cannot match to any other port — a lookup gap,
 * or a document whose own far port this `ClosetView` does not carry —
 * resolves to `undefined` rather than guessed past. */
function portByPassThroughId(view: ClosetView, passThroughId: string, exceptPortId: string): PortView | undefined {
  for (const rack of view.racks) {
    for (const chassis of rack.chassis) {
      const found = chassis.ports.find((p) => p.id !== exceptPortId && p.passThroughId === passThroughId);
      if (found) return found;
    }
  }
  return undefined;
}

/** ADR-0051 §1: the real pairing, `PortView.passThroughId` first — resolved
 * VIEW-WIDE (`portByPassThroughId`, not `chassis.ports`), since a
 * `PassThrough` edge's far port need not sit on the near port's own
 * chassis. Falls back to the old same-chassis label/row guess (`pairedPort`
 * above) only when `passThroughId` is `null`. A `passThroughId` naming an
 * edge this view cannot find a second port for resolves to `undefined` and
 * the walk simply stops there, rather than silently falling through to the
 * label guess: `passThroughId` set is a real, asserted fact, and a lookup
 * gap is a reason to fix the lookup, not a reason to guess past it. */
export function pairedPortFor(
  view: ClosetView,
  chassis: Pick<ChassisView, 'ports'>,
  port: Pick<PortView, 'id' | 'label' | 'row' | 'passThroughId'>,
): PortView | undefined {
  if (port.passThroughId != null) {
    return portByPassThroughId(view, port.passThroughId, port.id);
  }
  return pairedPort(chassis, port);
}

export interface LitPath {
  /** Every cable on the path, ordered end to end — the starting cable is
   * somewhere in the middle unless the path itself starts or ends there. */
  cableIds: string[];
  /** Portal tray group keys (`portals.ts`'s own `PortalGroup.key`) the path
   * reaches, in the order it reaches them. */
  trayKeys: string[];
}

interface Extension {
  cableIds: string[];
  trayKey?: string;
}

/** Walks outward from `end` (a real end of some cable already on the path,
 * away from that cable's other end): stops immediately unless `end` lands
 * on a port with a paired port that itself carries a cable, in which case
 * that cable joins the path and the walk continues from its own far end.
 * `visited` guards a cable graph that loops back on itself (a real document
 * should never form one, but a pure function does not get to assume the
 * document it is handed is one). `trayKeyOf` resolves a cable that ends
 * outside the closet to the portal tray it belongs to — `portals.ts`'s own
 * grouping, supplied by the caller rather than recomputed here.
 *
 * ADR-0051 §1: a port whose `passThroughId` names another port is a real,
 * schema-asserted continuation — "these two holes are the same hole" — and
 * the walk trusts it regardless of `isPanel` (an outlet box or a splitter is
 * not read as unpowered/"a panel" the way a patch panel is, but a
 * `PassThrough` on it is exactly as real). `isPanel` still gates the OLD
 * label/row guess (`pairedPort`, via `pairedPortFor`'s own fallback) — that
 * heuristic was only ever a stand-in for a panel's own pairing, and stays
 * scoped to what it was built for. */
function extend(
  view: ClosetView,
  end: RealEnd,
  visited: Set<string>,
  trayKeyOf: (cableId: string) => string | undefined,
): Extension {
  const found = findPort(view, end.portId);
  if (!found) return { cableIds: [] };
  if (found.port.passThroughId == null && !isPanel(found.chassis)) return { cableIds: [] };

  const paired = pairedPortFor(view, found.chassis, found.port);
  const nextEnd = paired?.cable;
  if (!paired || !nextEnd || visited.has(nextEnd.cableId)) return { cableIds: [] };

  const nextCable = view.cables?.find((c) => c.id === nextEnd.cableId);
  if (!nextCable) return { cableIds: [] };
  visited.add(nextCable.id);

  const nextReal = realEnds(nextCable);
  const farEnd = nextReal.find((e) => e.portId !== paired.id);
  if (farEnd) {
    const further = extend(view, farEnd, visited, trayKeyOf);
    return { cableIds: [nextCable.id, ...further.cableIds], trayKey: further.trayKey };
  }

  if (outsideLabel(nextCable) != null) {
    return { cableIds: [nextCable.id], trayKey: trayKeyOf(nextCable.id) };
  }
  return { cableIds: [nextCable.id] };
}

/**
 * The full path a cable sits on: itself, plus whatever panel continuations
 * its two ends reach outward into, plus the portal tray(s) it or those
 * continuations end at. `portalGroups` is `portals.ts`'s own `groupPortals`
 * output — passed in rather than recomputed so a caller that already built
 * it once (`Drawing.tsx`) never pays for it twice.
 */
export function litPathFor(view: ClosetView, startCableId: string, portalGroups: readonly PortalGroup[]): LitPath {
  const startCable = view.cables?.find((c) => c.id === startCableId);
  if (!startCable) return { cableIds: [], trayKeys: [] };

  const trayKeyOf = (cableId: string): string | undefined =>
    portalGroups.find((g) => g.cables.some((c) => c.cableId === cableId))?.key;

  const visited = new Set([startCableId]);
  const real = realEnds(startCable);

  let backward: Extension = { cableIds: [] };
  let forward: Extension = { cableIds: [] };
  if (real.length === 2) {
    backward = extend(view, real[0], visited, trayKeyOf);
    forward = extend(view, real[1], visited, trayKeyOf);
  } else if (real.length === 1) {
    // A cable with only one real end (its other end is outside, or not yet
    // run — 19 §3.4) has nowhere "forward" of it: the walk out from its one
    // real end is the only direction there is, read as `backward` so the
    // path orders the same way regardless of which cable on it a caller
    // started from (`litPathFor`'s own "hovering either end" tests).
    backward = extend(view, real[0], visited, trayKeyOf);
  }

  const cableIds = [...[...backward.cableIds].reverse(), startCableId, ...forward.cableIds];
  const trayKeys: string[] = [];
  if (backward.trayKey) trayKeys.push(backward.trayKey);
  const ownTray = trayKeyOf(startCableId);
  if (ownTray) trayKeys.push(ownTray);
  if (forward.trayKey) trayKeys.push(forward.trayKey);

  return { cableIds, trayKeys };
}
