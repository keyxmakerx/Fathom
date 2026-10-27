// The pure halves of the editor's controls: each builds the `EditorChange` a control raises, or
// the words a panel shows, so their shape is testable without rendering (`Editor.tsx` re-exports
// them for its existing importers).
import type { RackView } from '../../document/view';
import type { SwapPlan } from '../../document/swapModel';
import type { PortFace } from '../../document/compat';
import { ABSENT, UNNAMED_HOSTNAME, type CableEnd, type ClosetView, type EditorChange } from './contract';
import { locatePort } from './lookup';

export function moveToRackChange(itemId: string, rackId: string, positionU: number, face: 'front' | 'rear' = 'front'): EditorChange {
  return { kind: 'move-placement', itemId, placement: { kind: 'rack', rackId, positionU, face } };
}

export function moveToShelfChange(itemId: string, shelfId: string, slot: number): EditorChange {
  return { kind: 'move-placement', itemId, placement: { kind: 'shelf', shelfId, slot } };
}

/** `target.kind` tells a board (`FixedTo` another `PassiveNode`) from a
 * surface (`FixedTo` a `Surface`) — `view.ts`'s own `placementOf` reads the
 * same distinction back off which kind of node `FixedTo.to` names. */
export function moveToSurfaceChange(
  itemId: string,
  target: { id: string; kind: 'surface' | 'board' },
  xMm: number | null,
  yMm: number | null,
): EditorChange {
  return {
    kind: 'move-placement',
    itemId,
    placement:
      target.kind === 'board' ? { kind: 'board', boardId: target.id, xMm, yMm } : { kind: 'surface', surfaceId: target.id, xMm, yMm },
  };
}

export function addSketchPortChange(
  chassisId: string,
  label: string,
  connector: string,
  service: string | null,
  face: PortFace,
): EditorChange {
  return { kind: 'add-sketch-port', chassisId, label, connector, service, face };
}

export function removeSketchPortChange(chassisId: string, portId: string): EditorChange {
  return { kind: 'remove-sketch-port', chassisId, portId };
}

export function addSketchPortRangeChange(
  chassisId: string,
  labelPrefix: string,
  first: number,
  last: number,
  connector: string,
  service: string | null,
  face: PortFace,
): EditorChange {
  return { kind: 'add-sketch-port-range', chassisId, labelPrefix, first, last, connector, service, face };
}

export function duplicateDeviceChange(chassisId: string): EditorChange {
  return { kind: 'duplicate-device', chassisId };
}

export function createShelfChange(
  rackId: string,
  positionU: number,
  label: string,
  model: { vendor: string; model: string } | null,
): EditorChange {
  return { kind: 'create-shelf', rackId, positionU, label, model };
}

export function createSurfaceChange(premisesId: string, label: string, form: string): EditorChange {
  return { kind: 'create-surface', premisesId, label, form };
}

// ===========================================================================
// UI-SPEC "Cables" — the selected cable's own panel.
// `cableEndText` is pulled out pure, same reasoning as `moveToRackChange`
// and its siblings above: no DOM to render or click to simulate in this
// project's tests, so the wording a caller would see is asserted directly.
// `setCableFieldChange`/`disconnectCableChange` are the panel's own change-
// shape builders, the same pattern.

/** One end of the SELECTED cable, in words — UI-SPEC "Cables"' own panel
 * brief: "the two ends in words (device and port each side, or the outside
 * label)". `end` is one of `CableView.ends` (`document/view.ts`'s own
 * reduction of a `Terminates` edge, `contract.ts`'s re-export); `outside`
 * names the far side directly (`ExternalPeer.label`), everything else is
 * resolved through `locatePort` — the one entry point that finds a port
 * wherever this view draws one (a rack chassis, a shelf occupant or a
 * surface fixture, the same three the port panels below already read).
 * `ABSENT` when this view cannot resolve the port at all — never invented. */
export function cableEndText(view: ClosetView, end: CableEnd): string {
  if ('outside' in end) return end.label || ABSENT;
  const located = locatePort(view, end.portId);
  if (located == null) return ABSENT;
  const portLabel = located.port.label || ABSENT;
  if (located.place === 'chassis') return `${located.chassis.hostname || UNNAMED_HOSTNAME} · ${portLabel}`;
  if (located.place === 'shelf') return `${located.occupant.label || ABSENT} · ${portLabel}`;
  return `${located.fixture.label || ABSENT} · ${portLabel}`;
}

/** A selected port's own far end: the
 * OTHER end of the cable filling it (`CableView.ends` holds 0, 1 or 2 —
 * `document/view.ts`'s own doc on `Terminates`'s "0..2" cardinality), found
 * by excluding the end that IS `thisPortId`. `undefined` when this view
 * carries no such cable (never invented) or the cable has no other end yet
 * — the call site falls back to `ABSENT`, the same "search, never guess"
 * rule `lookup.ts` already keeps throughout this module. */
export function farEndOf(view: ClosetView, cableId: string, thisPortId: string): CableEnd | undefined {
  const cable = view.cables.find((c) => c.id === cableId);
  if (cable == null) return undefined;
  return cable.ends.find((e) => !('portId' in e) || e.portId !== thisPortId);
}

/** `document/cables.ts`'s `setCableField`, through `EditorActions.onEdit` —
 * `value` is always the raw text a field holds (`contract.ts`'s own doc on
 * `EditorChange`'s `'cable'` kind: `length_m` is parsed to a number by the
 * caller, `useDesignSession.ts`'s `handleEdit`, before `setCableField` gets
 * a chance to refuse it). */
export function setCableFieldChange(
  id: string,
  field: 'label' | 'sheath' | 'length_m' | 'ownership',
  value: string | null,
): EditorChange {
  return { kind: 'cable', id, field, value };
}

/** The panel's own "Disconnect" action — `document/cables.ts`'s
 * `disconnect`, an action rather than a field edit, the same shape
 * `'supply-remove'` already is. */
export function disconnectCableChange(id: string): EditorChange {
  return { kind: 'cable-disconnect', id };
}

/** Missing links: a cable from this free port with its far end open. */
export function oneEndCableChange(portId: string): EditorChange {
  return { kind: 'cable-one-end', portId };
}

/** Missing links: the cable panel's "Needs finishing" toggle. */
export function needsFinishingChange(id: string, on: boolean): EditorChange {
  return { kind: 'cable-needs-finishing', id, on };
}

/** UI-SPEC's cable-delete rule — the device panel's "Remove device"
 * action: `document/commands.ts`'s `removeChassis`, the same shape
 * `disconnectCableChange` above already is. */
export function removeDeviceChange(chassisId: string): EditorChange {
  return { kind: 'device-remove', chassisId };
}

/** Pure: why `rack` can't be `heightU` tall, naming the highest thing in the way, or null. */
export function rackHeightBlocker(rack: Pick<RackView, 'chassis' | 'shelves'>, heightU: number): string | null {
  let worst: { name: string; top: number } | null = null;
  const consider = (name: string, positionU: number, unitHeight: number) => {
    const top = positionU + unitHeight - 1;
    if (top > heightU && (worst === null || top > worst.top)) worst = { name, top };
  };
  for (const c of rack.chassis) consider(c.hostname || c.model || 'a device', c.positionU, c.heightU);
  for (const s of rack.shelves) consider(s.label || 'a shelf', s.positionU, s.heightU);
  const found = worst as { name: string; top: number } | null;
  return found ? `It can't go below ${found.top}U, because ${found.name} reaches U${found.top}.` : null;
}

export function swapModelChange(chassisId: string, model: { vendor: string; model: string }): EditorChange {
  return { kind: 'swap-model', chassisId, model };
}

/** What a swap would do, in sentences, for the panel to show before the person confirms. */
export function swapSummary(plan: SwapPlan): string[] {
  const lines: string[] = [];
  const cabled = plan.kept.filter((p) => p.cabled).length;
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`;
  if (plan.kept.length > 0) {
    lines.push(`${n(plan.kept.length, 'port')} ${plan.kept.length === 1 ? 'carries' : 'carry'} over${cabled > 0 ? `, ${cabled} with ${cabled === 1 ? 'its cable' : 'their cables'}` : ''}.`);
  }
  const renamed = plan.kept.filter((p) => p.newLabel != null);
  if (renamed.length > 0) lines.push(`Renamed to the new model's numbering: ${renamed.map((p) => `${p.label || ABSENT} to ${p.newLabel}`).join(', ')}.`);
  const changed = plan.kept.filter((p) => p.cabled && p.connectorChanged);
  if (changed.length > 0) lines.push(`New connector on ${changed.map((p) => p.label).join(', ')}: Checks will say if a cable no longer fits.`);
  if (plan.added.length > 0) lines.push(`${n(plan.added.length, 'new port')}.`);
  const loose = plan.dropped.filter((p) => p.cableId != null);
  const bare = plan.dropped.length - loose.length;
  if (loose.length > 0) {
    lines.push(`Not on the new model: ${loose.map((p) => p.label || ABSENT).join(', ')}. ${loose.length === 1 ? 'Its cable stays as a loose end' : 'Their cables stay as loose ends'} in Missing links.`);
  }
  if (bare > 0) lines.push(`${n(bare, 'empty port')} the new model lacks will go.`);
  if (plan.height) lines.push(`${plan.height.from}U becomes ${plan.height.to}U, from the same bottom unit.`);
  if (plan.serial != null) lines.push(`Serial ${plan.serial} is cleared: a new box has its own.`);
  lines.push('One undo puts the old box back.');
  return lines;
}

