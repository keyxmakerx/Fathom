/** Field-by-field equality for the view shapes a rack, chassis, shelf,
 * surface or tray node renders from — used to decide whether a fresh view
 * object (any edit rebuilds the whole `ClosetView`) actually changed
 * anything that one node draws, without stringifying it. */

import type { ChassisView, InletView, PortView, Sheath } from './contract';
import type { FixtureView, OccupantView, ShelfView } from '../../document/view';
import type { FaceplateItem } from './elevation';
import type { PortalGroup } from './portals';
import type { SurfacePlacement } from './rows';

function portFieldsEqual(a: PortView, b: PortView): boolean {
  if (
    a.id !== b.id ||
    a.label !== b.label ||
    a.connector !== b.connector ||
    a.row !== b.row ||
    a.column !== b.column ||
    a.uplink !== b.uplink ||
    a.role !== b.role ||
    a.face !== b.face ||
    a.passThroughId !== b.passThroughId ||
    (a.service ?? null) !== (b.service ?? null)
  ) {
    return false;
  }
  const ca = a.cable ?? null;
  const cb = b.cable ?? null;
  if (ca === cb) return true;
  if (ca == null || cb == null) return false;
  return ca.cableId === cb.cableId && ca.farPortId === cb.farPortId && ca.farChassisId === cb.farChassisId && ca.outsideCloset === cb.outsideCloset;
}

function inletFieldsEqual(a: InletView, b: InletView): boolean {
  return (
    portFieldsEqual(a, b) &&
    a.slot === b.slot &&
    a.hotSwap === b.hotSwap &&
    a.fitted === b.fitted &&
    a.supplyId === b.supplyId &&
    a.serial === b.serial &&
    a.model === b.model &&
    a.position?.row === b.position?.row &&
    a.position?.column === b.position?.column
  );
}

function portsEqual(a: readonly PortView[], b: readonly PortView[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (!portFieldsEqual(a[i]!, b[i]!)) return false;
  return true;
}

function inletsEqual(a: readonly InletView[], b: readonly InletView[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (!inletFieldsEqual(a[i]!, b[i]!)) return false;
  return true;
}

export function chassisEqual(a: ChassisView, b: ChassisView): boolean {
  return (
    a.id === b.id &&
    a.hostname === b.hostname &&
    a.model === b.model &&
    a.vendor === b.vendor &&
    a.positionU === b.positionU &&
    a.heightU === b.heightU &&
    a.face === b.face &&
    a.role === b.role &&
    a.managementAddress === b.managementAddress &&
    a.serial === b.serial &&
    a.singleFed === b.singleFed &&
    a.oneFitted === b.oneFitted &&
    a.sketch === b.sketch &&
    portsEqual(a.ports, b.ports) &&
    inletsEqual(a.psuInlets, b.psuInlets)
  );
}

export function occupantEqual(a: OccupantView, b: OccupantView): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.model === b.model &&
    a.slot === b.slot &&
    a.sketch === b.sketch &&
    portsEqual(a.ports, b.ports)
  );
}

export function shelfEqual(a: ShelfView, b: ShelfView): boolean {
  if (a.id !== b.id || a.label !== b.label || a.positionU !== b.positionU || a.heightU !== b.heightU) return false;
  if (a.occupants.length !== b.occupants.length) return false;
  for (let i = 0; i < a.occupants.length; i += 1) if (!occupantEqual(a.occupants[i]!, b.occupants[i]!)) return false;
  return true;
}

function sortedFreeRuns(runs: readonly { fromU: number; toU: number }[]): { fromU: number; toU: number }[] {
  return [...runs].sort((x, y) => x.fromU - y.fromU || x.toU - y.toU);
}

export function freeRunsEqual(a: readonly { fromU: number; toU: number }[], b: readonly { fromU: number; toU: number }[]): boolean {
  if (a.length !== b.length) return false;
  const sa = sortedFreeRuns(a);
  const sb = sortedFreeRuns(b);
  for (let i = 0; i < sa.length; i += 1) if (sa[i]!.fromU !== sb[i]!.fromU || sa[i]!.toU !== sb[i]!.toU) return false;
  return true;
}

function fixtureEqual(a: FixtureView, b: FixtureView): boolean {
  if (
    a.id !== b.id ||
    a.kind !== b.kind ||
    a.label !== b.label ||
    a.model !== b.model ||
    a.form !== b.form ||
    a.xMm !== b.xMm ||
    a.yMm !== b.yMm
  ) {
    return false;
  }
  if (!portsEqual(a.ports, b.ports) || !inletsEqual(a.psuInlets, b.psuInlets)) return false;
  return fixturesEqual(a.fixtures, b.fixtures); // a board nests its own occupants the same way
}

function fixturesEqual(a: readonly FixtureView[], b: readonly FixtureView[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (!fixtureEqual(a[i]!, b[i]!)) return false;
  return true;
}

export function placementEqual(a: SurfacePlacement, b: SurfacePlacement): boolean {
  if (a.x !== b.x || a.y !== b.y || a.widthPx !== b.widthPx || a.heightPx !== b.heightPx) return false;
  const sa = a.surface;
  const sb = b.surface;
  if (sa.id !== sb.id || sa.label !== sb.label || sa.form !== sb.form || sa.widthMm !== sb.widthMm || sa.heightMm !== sb.heightMm) return false;
  return fixturesEqual(sa.fixtures, sb.fixtures);
}

export function portalGroupEqual(a: PortalGroup, b: PortalGroup): boolean {
  if (a.key !== b.key || a.rackId !== b.rackId || a.side !== b.side || a.label !== b.label) return false;
  if (a.cables.length !== b.cables.length) return false;
  for (let i = 0; i < a.cables.length; i += 1) {
    const ca = a.cables[i]!;
    const cb = b.cables[i]!;
    if (ca.cableId !== cb.cableId || ca.kind !== cb.kind || ca.nearPortId !== cb.nearPortId) return false;
  }
  return true;
}

export function portSheathEqual(a: ReadonlyMap<string, Sheath>, b: ReadonlyMap<string, Sheath>): boolean {
  if (a.size !== b.size) return false;
  for (const [portId, sheath] of a) if (b.get(portId) !== sheath) return false;
  return true;
}

/** A rack's own bounded slice — never the whole `RackView`, and never the
 * design around it — with `freeRuns` pre-sorted by the caller so a no-op
 * move never reads as a change. */
export interface RackSnapshot {
  label: string;
  heightU: number;
  freeRuns: readonly { fromU: number; toU: number }[];
}

export function rackSnapshotEqual(a: RackSnapshot, b: RackSnapshot): boolean {
  return a.label === b.label && a.heightU === b.heightU && freeRunsEqual(a.freeRuns, b.freeRuns);
}

function faceplateItemEqual(a: FaceplateItem, b: FaceplateItem): boolean {
  return (
    a.visibleFace === b.visibleFace &&
    a.plainPlate === b.plainPlate &&
    chassisEqual(a.chassis, b.chassis) &&
    portsEqual(a.ports, b.ports) &&
    inletsEqual(a.inlets, b.inlets)
  );
}

export function faceplateItemsEqual(a: readonly FaceplateItem[], b: readonly FaceplateItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (!faceplateItemEqual(a[i]!, b[i]!)) return false;
  return true;
}
