// The tree beside the Back button: where you are INSIDE the design, outermost first. It is containment,
// not history: design, then the rack (or wall) the thing sits in, the shelf, the device, and whatever
// deeper you have gone (the device opened full-size, a close-up of its faceplate, a port). Every line is
// read from the document's own containment (a rack holds devices and shelves, a shelf holds devices, a
// wall holds fixtures, a device holds ports); a level the model lacks is not invented, so there is no
// site or room line until the document has one. Pure: `JumpTree.tsx` draws it and `foldTrail` shortens it.

import type { ClosetView } from '../drawing/contract';
import { findChassis, findFixture, findOccupant, findRack, findShelf, findUnplacedChassis, locatePort } from '../drawing/lookup';
import type { Look } from '../drawing/look';
import type { CameraStop } from '../drawing/geometry';
import type { Spot } from './jumpBack';

/** The small word beside a name. */
export type LevelKind = 'design' | 'rack' | 'shelf' | 'wall' | 'device' | 'fixture' | 'view' | 'port' | 'cable' | 'label' | 'line';

export interface Level {
  /** Stable within one tree. */
  key: string;
  name: string;
  kind: LevelKind;
  /** Where clicking the line goes, in the same terms Back uses; null for a level that cannot be chosen (a wall). */
  target: Spot | null;
}

export interface TreeInput {
  /** The design's own name, from the top bar. */
  designName: string;
  look: Look;
  selection: { kind: string; id: string } | null;
  /** The device opened full-size, if any. */
  jotId: string | null;
  stop: CameraStop;
}

const KIND_WORD: Record<LevelKind, string> = {
  design: 'DESIGN',
  rack: 'RACK',
  shelf: 'SHELF',
  wall: 'WALL',
  device: 'DEVICE',
  fixture: 'FIXTURE',
  view: 'VIEW',
  port: 'PORT',
  cable: 'CABLE',
  label: 'LABEL',
  line: 'LINE',
};

export const kindWord = (kind: LevelKind): string => KIND_WORD[kind];

/** The most lines shown before the middle folds. */
export const MAX_SHOWN = 6;
export const KEEP_TOP = 2;
const KEEP_END = 3;

export type TrailLine = { type: 'level'; level: Level; index: number } | { type: 'fold'; hidden: readonly Level[] };

/**
 * The lines to draw. Up to six levels show in full. Past six, the top two and the last three show and the
 * middle folds into one "N more" line; `expanded` (the fold clicked open) shows every level.
 */
export function foldTrail(levels: readonly Level[], expanded = false): TrailLine[] {
  const all: TrailLine[] = levels.map((level, index) => ({ type: 'level', level, index }));
  if (expanded || levels.length <= MAX_SHOWN) return all;
  return [...all.slice(0, KEEP_TOP), { type: 'fold', hidden: levels.slice(KEEP_TOP, levels.length - KEEP_END) }, ...all.slice(levels.length - KEEP_END)];
}

const word = (s: string, fallback: string): string => (s.trim() === '' ? fallback : s.trim());

/** The chain of levels for what is selected or open. `levels[0]` is the design; the last is "you are here". */
export function levelsFor(view: ClosetView, input: TreeInput): Level[] {
  const { look, selection, jotId, stop } = input;
  const design: Level = {
    key: 'design',
    name: word(input.designName, 'Overview'),
    kind: 'design',
    target: { look, selection: null, jotId: null, stop: 'closet' },
  };
  const out: Level[] = [design];
  const at = (sel: { kind: string; id: string } | null, open: string | null = null, s: CameraStop = 'rack'): Spot => ({ look, selection: sel, jotId: open, stop: s });
  const rackLevel = (id: string, label: string): Level => ({ key: `rack:${id}`, name: word(label, 'Rack'), kind: 'rack', target: at({ kind: 'rack', id }) });
  const shelfLevel = (id: string, label: string): Level => ({ key: `shelf:${id}`, name: word(label, 'Shelf'), kind: 'shelf', target: at({ kind: 'shelf', id }) });

  /** A device by id, wherever it sits: rack, shelf, or on the open canvas. Null when the view has no such device. */
  const deviceChain = (id: string): Level[] | null => {
    const racked = findChassis(view, id);
    if (racked != null) {
      return [rackLevel(racked.rack.id, racked.rack.label), { key: `device:${id}`, name: word(racked.chassis.hostname, 'Unnamed device'), kind: 'device', target: at({ kind: 'chassis', id }) }];
    }
    if (findUnplacedChassis(view, id) != null) {
      const c = findUnplacedChassis(view, id)!;
      return [{ key: `device:${id}`, name: word(c.hostname, 'Unnamed device'), kind: 'device', target: at({ kind: 'chassis', id }) }];
    }
    const occ = findOccupant(view, id);
    if (occ != null) {
      return [
        rackLevel(occ.rack.id, occ.rack.label),
        shelfLevel(occ.shelf.id, occ.shelf.label),
        { key: `device:${id}`, name: word(occ.occupant.label, 'Device'), kind: 'device', target: at({ kind: 'occupant', id }) },
      ];
    }
    return null;
  };

  /** The thing a port belongs to, and its own line. */
  const portChain = (portId: string): Level[] => {
    const loc = locatePort(view, portId);
    if (loc == null) return [];
    const name = (p: { label: string }) => word(p.label, 'Port');
    const own: Level = { key: `port:${portId}`, name: name(loc.port), kind: 'port', target: at({ kind: 'port', id: portId }) };
    if (loc.place === 'chassis') return [rackLevel(loc.rack.id, loc.rack.label), { key: `device:${loc.chassis.id}`, name: word(loc.chassis.hostname, 'Unnamed device'), kind: 'device', target: at({ kind: 'chassis', id: loc.chassis.id }) }, own];
    if (loc.place === 'shelf') {
      return [
        rackLevel(loc.rack.id, loc.rack.label),
        shelfLevel(loc.shelf.id, loc.shelf.label),
        { key: `device:${loc.occupant.id}`, name: word(loc.occupant.label, 'Device'), kind: 'device', target: at({ kind: 'occupant', id: loc.occupant.id }) },
        own,
      ];
    }
    return [
      { key: `wall:${loc.surface.id}`, name: word(loc.surface.label, 'Wall'), kind: 'wall', target: null },
      { key: `fixture:${loc.fixture.id}`, name: word(loc.fixture.label, 'Fixture'), kind: 'fixture', target: at({ kind: 'fixture', id: loc.fixture.id }) },
      own,
    ];
  };

  // The device the person is in, if any: the one opened, else the selected device, else a selected port's owner.
  if (jotId != null) {
    const chain = deviceChain(jotId);
    if (chain != null) {
      out.push(...chain);
      const device = chain[chain.length - 1]!;
      out.push({ key: 'view:open', name: 'Open', kind: 'view', target: at(device.target?.selection ?? null, jotId, stop) });
      // A port picked inside the open device is the deepest level.
      const port = selection?.kind === 'port' ? portChain(selection.id).find((l) => l.kind === 'port') : undefined;
      if (port != null) out.push(port);
      return out;
    }
  }
  if (selection == null) return out;
  const { kind, id } = selection;
  switch (kind) {
    case 'rack': {
      const rack = findRack(view, id);
      if (rack != null) out.push(rackLevel(rack.id, rack.label));
      return out;
    }
    case 'shelf': {
      const found = findShelf(view, id);
      if (found != null) out.push(rackLevel(found.rack.id, found.rack.label), shelfLevel(found.shelf.id, found.shelf.label));
      return out;
    }
    case 'chassis':
    case 'occupant': {
      const chain = deviceChain(id);
      if (chain == null) return out;
      out.push(...chain);
      // Close in on a device and its faceplate (or the inside) is the deepest level you are at.
      if (stop === 'faceplate' || stop === 'inside') {
        const device = chain[chain.length - 1]!;
        out.push({ key: `view:${stop}`, name: stop === 'inside' ? 'Inside' : 'Faceplate', kind: 'view', target: at(device.target?.selection ?? null, null, stop) });
      }
      return out;
    }
    case 'port':
      out.push(...portChain(id));
      return out;
    case 'fixture': {
      const found = findFixture(view, id);
      if (found != null) {
        out.push({ key: `wall:${found.surface.id}`, name: word(found.surface.label, 'Wall'), kind: 'wall', target: null });
        if (found.parent != null) out.push({ key: `fixture:${found.parent.id}`, name: word(found.parent.label, 'Fixture'), kind: 'fixture', target: at({ kind: 'fixture', id: found.parent.id }) });
        out.push({ key: `fixture:${id}`, name: word(found.fixture.label, 'Fixture'), kind: 'fixture', target: at({ kind: 'fixture', id }) });
      }
      return out;
    }
    case 'cable': {
      const c = (view.cables ?? []).find((x) => x.id === id);
      if (c != null) out.push({ key: `cable:${id}`, name: word(c.label ?? '', 'Cable'), kind: 'cable', target: at({ kind: 'cable', id }) });
      return out;
    }
    case 'label': {
      const l = (view.labels ?? []).find((x) => x.id === id);
      if (l != null) out.push({ key: `label:${id}`, name: word(l.text.slice(0, 24), 'Label'), kind: 'label', target: at({ kind: 'label', id }) });
      return out;
    }
    default:
      out.push({ key: `line:${id}`, name: 'Line', kind: 'line', target: at({ kind: 'line', id }) });
      return out;
  }
}

/** Which line takes focus after an arrow key, Home or End; `null` for any other key. */
export function nextFocus(count: number, current: number, key: string): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown':
      return Math.min(count - 1, current + 1);
    case 'ArrowUp':
      return Math.max(0, current - 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
