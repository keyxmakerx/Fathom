// What the browser gives a screen reader for the things on the drawing that take the keyboard. Each has its own
// name first, then what is worth hearing before Enter: where it is, what it holds, what it joins. React Flow's own
// words were no name at all for a device, a rack, a shelf or a wall, and "Edge from <id> to <id>" for a cable.
// The kind of thing is said in place of React Flow's "node" and "edge" (`SAID_AS`). Pure; `buildDrawingNodes.ts`,
// `Drawing.tsx`, the free layer and the Diagram look hand these to React Flow as `ariaLabel` and `domAttributes`.

import { naturalLabelCompare, type FixtureView, type SurfaceView } from '../../document/view';
import { deviceNameIndex } from './cableGroups';
import { UNNAMED_HOSTNAME, type CableView, type ChassisView, type ClosetView } from './contract';

/** A thing Enter does not select. React Flow follows every name with "Press Enter to select it." (`nodeKey.ts`),
 * which is untrue of these, so they go without it. */
const NO_ENTER = { 'aria-describedby': undefined } as const;

/** The kind of thing, read after its name where React Flow says "node" or "edge". */
export const SAID_AS = {
  device: { 'aria-roledescription': 'device' },
  rack: { 'aria-roledescription': 'rack' },
  shelf: { 'aria-roledescription': 'shelf' },
  row: { 'aria-roledescription': 'row', ...NO_ENTER },
  wall: { 'aria-roledescription': 'wall' },
  desk: { 'aria-roledescription': 'desk' },
  ceiling: { 'aria-roledescription': 'ceiling' },
  floor: { 'aria-roledescription': 'floor' },
  wayOut: { 'aria-roledescription': 'cables that leave this room', ...NO_ENTER },
  cable: { 'aria-roledescription': 'cable' },
  cables: { 'aria-roledescription': 'cables', ...NO_ENTER },
  label: { 'aria-roledescription': 'label' },
  area: { 'aria-roledescription': 'area' },
  note: { 'aria-roledescription': 'note' },
  line: { 'aria-roledescription': 'line' },
} as const;

/** Names read aloud: "a", "a and b", "a, b and c", and past three "a, b, c and 2 more". */
export function saidList(names: readonly string[]): string {
  const named = names.map((n) => n.trim()).filter((n) => n !== '');
  if (named.length === 0) return '';
  if (named.length === 1) return named[0]!;
  if (named.length <= 3) return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  return `${named.slice(0, 3).join(', ')} and ${named.length - 3} more`;
}

const units = (positionU: number, heightU: number): string => (heightU <= 1 ? `U${positionU}` : `U${positionU} to U${positionU + heightU - 1}`);

/** "access_point" -> "access point"; no role, or "other", says nothing. */
function roleSaid(role: string | null | undefined): string {
  const words = (role ?? '').replace(/_/g, ' ').trim();
  return words === 'other' ? '' : words;
}

const joined = (parts: readonly string[]): string => parts.filter((p) => p !== '').join(', ');

/** Name order, a number in a name by its value: "switch-2" before "switch-10". What is read out goes in this order
 * wherever the design keeps no order of its own: the two ends of a cable, the things on a wall. Left as the design
 * holds them, two things made in the same millisecond came out either way round, so one design said "a to b" and
 * its copy "b to a". */
function byName(a: string, b: string): number {
  return naturalLabelCompare(a.toLowerCase(), b.toLowerCase()) || naturalLabelCompare(a, b);
}

/** "router-1, router, Rack 1 U10". */
export function deviceSays(chassis: Pick<ChassisView, 'hostname' | 'role' | 'positionU' | 'heightU'>, rackLabel: string): string {
  return joined([chassis.hostname.trim() || UNNAMED_HOSTNAME, roleSaid(chassis.role), `${rackLabel.trim() || 'Rack'} ${units(chassis.positionU, chassis.heightU)}`]);
}

/** A device that is not in a rack unit, by the place it has: "nas, server, not in a rack". */
export function looseDeviceSays(name: string, role: string | null | undefined, where: string): string {
  return joined([name.trim() || UNNAMED_HOSTNAME, roleSaid(role), where.trim()]);
}

/** A thing fixed to a wall, a desk or a ceiling: "switch-2, switch", "outlet-1, outlet". Where it hangs is said by
 * its wall, which the keyboard has just left (r159). */
export function fixtureSays(fixture: { label: string; form: string | null; chassis?: { role?: string | null } | undefined }): string {
  return joined([fixture.label.trim() || UNNAMED_HOSTNAME, roleSaid(fixture.chassis?.role ?? fixture.form)]);
}

/** "Rack 1, 12U, 3U used". */
export function rackSays(rack: { label: string; heightU: number; chassis: readonly { heightU: number }[]; shelves?: readonly { heightU: number }[] | undefined }): string {
  const used = rack.chassis.reduce((n, c) => n + c.heightU, 0) + (rack.shelves ?? []).reduce((n, s) => n + s.heightU, 0);
  return joined([rack.label.trim() || 'Rack', `${rack.heightU}U`, `${used}U used`]);
}

/** "Shelf, Rack 1 U6, holds nas-1, server-1 and pi-1". */
export function shelfSays(shelf: { label: string; positionU: number; heightU: number; occupants: readonly { label: string }[] }, rackLabel: string): string {
  const on = saidList(shelf.occupants.map((o) => o.label));
  return joined([shelf.label.trim() || 'Shelf', `${rackLabel.trim() || 'Rack'} ${units(shelf.positionU, shelf.heightU)}`, on !== '' ? `holds ${on}` : 'nothing on it']);
}

/** Every thing fixed to a wall, the things on its boards included, in name order. */
function fixtureNames(fixtures: readonly FixtureView[]): string[] {
  const all = (list: readonly FixtureView[]): string[] => list.flatMap((f) => [f.label, ...all(f.fixtures)]);
  return all(fixtures).sort(byName);
}

/** "Outside wall, holds camera-1 and camera-2". */
export function surfaceSays(surface: Pick<SurfaceView, 'label' | 'form' | 'fixtures'>): string {
  const on = saidList(fixtureNames(surface.fixtures));
  return joined([surface.label.trim() || surface.form, on !== '' ? `holds ${on}` : 'nothing on it']);
}

/** "Row A, seen from the front". */
export function rowSays(label: string | null, elevation: 'front' | 'rear'): string {
  return joined([(label ?? '').trim() || 'Row', `seen from the ${elevation}`]);
}

/** "ISP modem, 1 copper": where the cables go, and how many of each kind. */
export function wayOutSays(label: string, countLabel: string): string {
  return joined([label.trim() || 'Outside this room', countLabel.replace(/ · /g, ', ')]);
}

const portWordCache = new WeakMap<ClosetView, ReadonlyMap<string, string>>();

/** "port 2", or a power inlet's slot alone ("PSU1"); a label that says "Port" itself is not given the word twice. */
function portWord(port: { label: string; slot?: unknown }): string {
  const slot = typeof port.slot === 'string' ? port.slot.trim() : '';
  if (slot !== '') return slot;
  const label = port.label.trim();
  return label === '' || /^port\b/i.test(label) ? label : `port ${label}`;
}

/** What each port is called, by id. Built once a view. */
function portWords(view: ClosetView): ReadonlyMap<string, string> {
  const cached = portWordCache.get(view);
  if (cached) return cached;
  const map = new Map<string, string>();
  const note = (ports: readonly { id: string; label: string; slot?: unknown }[]): void => {
    for (const p of ports) map.set(p.id, portWord(p));
  };
  const walk = (fixtures: readonly FixtureView[]): void => {
    for (const f of fixtures) {
      note(f.ports);
      note(f.psuInlets);
      walk(f.fixtures);
    }
  };
  for (const rack of view.racks ?? []) {
    for (const c of rack.chassis) {
      note(c.ports);
      note(c.psuInlets);
    }
    for (const shelf of rack.shelves ?? []) for (const occ of shelf.occupants) note(occ.ports);
  }
  for (const surface of view.surfaces ?? []) walk(surface.fixtures);
  for (const c of view.unplaced ?? []) {
    note(c.ports);
    note(c.psuInlets);
  }
  portWordCache.set(view, map);
  return map;
}

/** "Office run, switch-1 port 2 to switch-2 port 1"; a power lead, "pdu-1 port 3 to switch-1 PSU1". An end
 * outside says so, and so does an end not connected. */
export function cableSays(view: ClosetView, cable: Pick<CableView, 'label' | 'ends'>): string {
  const names = deviceNameIndex(view);
  const ports = portWords(view);
  // The end in this room first, so the words start on a thing that is on the drawing; two ends in this room in
  // name order, whichever the design holds first.
  const ends = cable.ends
    .map((end) => {
      if ('outside' in end) return { outside: true, words: end.label.trim() !== '' ? `${end.label.trim()}, outside this room` : 'outside this room' };
      return { outside: false, words: [names.get(end.chassisId) ?? UNNAMED_HOSTNAME, ports.get(end.portId) ?? ''].filter((s) => s !== '').join(' ') };
    })
    .sort((a, b) => Number(a.outside) - Number(b.outside) || byName(a.words, b.words))
    .map((end) => end.words);
  const run = ends.length >= 2 ? `${ends[0]} to ${ends[1]}` : ends.length === 1 ? `${ends[0]}, other end not connected` : 'not connected';
  return joined([(cable.label ?? '').trim(), run]);
}

/** A line drawn between two boxes on the open canvas: "uplink, nas to switch". */
export function lineSays(label: string | null, nameA: string, nameB: string): string {
  return joined([(label ?? '').trim(), `${nameA.trim() || UNNAMED_HOSTNAME} to ${nameB.trim() || UNNAMED_HOSTNAME}`]);
}

/** "2 cables, router-1 to switch-1": a band that stands for several, its two devices in name order. */
export function cablesSay(view: ClosetView, count: number, chassisA: string, chassisB: string): string {
  const names = deviceNameIndex(view);
  const [first, second] = [names.get(chassisA) ?? UNNAMED_HOSTNAME, names.get(chassisB) ?? UNNAMED_HOSTNAME].sort(byName);
  return `${count} cables, ${first} to ${second}`;
}
