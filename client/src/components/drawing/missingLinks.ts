/** Missing links (round 26 point 6, round 27 points 1-2): loose ends Fathom finds from the drawing,
 * nothing typed. A loose end is Needs finishing (a person marked it; counted in the top bar) or
 * Unknown (the default; listed folded, never counted). Pure.
 *
 * Circuits join later: they produce `LooseEnd`s with `source: 'circuit'` and `state:
 * 'needs-finishing'` (a circuit's open end always starts that way) and hand them to
 * `splitLooseEnds` with the cables'; the count, the list and the bar need no change. */

import { locatePort } from './lookup';
import type { ClosetView } from './contract';

export type LooseState = 'needs-finishing' | 'unknown';

export interface LooseEnd {
  /** What has the loose end. Only cables exist today. */
  source: 'cable' | 'circuit';
  /** The cable's (or circuit's) id: what Go selects. */
  id: string;
  state: LooseState;
  /** The device the connected end sits on, as named in the drawing; '' when it has no name. */
  device: string;
  /** The connected end's port label; '' when it has none. */
  port: string;
  /** The port the connected end sits in, for a cable. */
  portId?: string;
  /** The cable's own label, when it has one. */
  label?: string;
}

/** The device and port names of one port, whichever place it sits in. */
function namesOf(view: ClosetView, portId: string): { device: string; port: string } {
  const at = locatePort(view, portId);
  if (at == null) return { device: '', port: '' };
  const port = at.port.label ?? '';
  if (at.place === 'chassis') return { device: at.chassis.hostname ?? '', port };
  if (at.place === 'shelf') return { device: at.occupant.label ?? '', port };
  return { device: at.fixture.label ?? '', port };
}

/** Every cable in the drawing with exactly one end connected, to a port that is on the canvas.
 * A cable with both ends connected is never loose, whatever `needsFinishing` says; one that ends
 * outside the closet has its far end (the outside), so it is not loose either. Patch-panel ports
 * used on one face are not cables with a missing end and never appear here. */
export function cableLooseEnds(view: ClosetView): LooseEnd[] {
  const out: LooseEnd[] = [];
  for (const cable of view.cables ?? []) {
    if (cable.looseEnd !== true) continue;
    const end = cable.ends.length === 1 ? cable.ends[0] : undefined;
    if (end == null || !('portId' in end)) continue;
    const names = namesOf(view, end.portId);
    out.push({
      source: 'cable',
      id: cable.id,
      state: cable.needsFinishing === true ? 'needs-finishing' : 'unknown',
      device: names.device,
      port: names.port,
      portId: end.portId,
      ...(cable.label != null && cable.label !== '' ? { label: cable.label } : {}),
    });
  }
  return out;
}

/** A port whose cable has nothing at its other end (not an outside peer): plugging a free port
 * into it finishes that cable. */
export function isLoosePort(port: { cable?: { farPortId: string | null; outsideCloset: boolean } | null }): boolean {
  const c = port.cable;
  return c != null && c.farPortId == null && !c.outsideCloset;
}

/** React Flow's connection flags for a port's handle: a cabled port cannot start a new cable, and
 * cannot receive one, except that a one-ended cable's port can receive the drop that finishes it. */
export function portHandleFlags(cabled: boolean, loose: boolean): { isConnectableStart: boolean; isConnectableEnd: boolean } {
  return { isConnectableStart: !cabled, isConnectableEnd: !cabled || loose };
}

export interface MissingLinks {
  /** Counted in the bar. */
  needsFinishing: LooseEnd[];
  /** Folded at the bottom of the list; never counted. */
  unknown: LooseEnd[];
}

/** Splits loose ends into the two kinds, each in a steady order (device, then port). */
export function splitLooseEnds(ends: readonly LooseEnd[]): MissingLinks {
  const order = (a: LooseEnd, b: LooseEnd): number =>
    a.device.localeCompare(b.device) || a.port.localeCompare(b.port, undefined, { numeric: true }) || a.id.localeCompare(b.id);
  return {
    needsFinishing: ends.filter((e) => e.state === 'needs-finishing').sort(order),
    unknown: ends.filter((e) => e.state === 'unknown').sort(order),
  };
}

/** The bar's number: Needs finishing only. Zero hides the button. */
export function missingLinkCount(found: MissingLinks): number {
  return found.needsFinishing.length;
}

/** "sw-01 3 → (no far end)"; an unnamed device or port is left out rather than invented. */
export function looseEndText(end: LooseEnd): string {
  const near = [end.device === '' ? 'unnamed device' : end.device, end.port].filter((p) => p !== '').join(' ');
  return `${near} → (no far end)`;
}

/** All of a design's missing links: today its cables'. */
export function missingLinksOf(view: ClosetView): MissingLinks {
  return splitLooseEnds(cableLooseEnds(view));
}
