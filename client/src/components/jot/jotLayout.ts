// ADR-0060 decision 10 "jot mode": the open device and the equipment around it, in the canvas's own
// flow units. The device sits at the stage origin; everything else is placed relative to where the
// device is on the full canvas, so a box dropped here lands beside it there.

import type { CableView, ChassisView, ClosetView } from '../../document/view';
import { findChassis, findOccupant, findUnplacedChassis } from '../drawing/lookup';
import { faceplateLayoutFor, type FaceplateLayout } from '../drawing/faceplate';
import { RACK_INNER_PX, U_PX } from '../drawing/geometry';
import { BOX_H, BOX_W } from '../../document/freeform';

export const PLATE_W = RACK_INNER_PX;
/** Room above a plate for its name. */
export const NAME_PX = 14;
/** Free boxes within this many flow units of the device show beside it. */
const NEAR = 900;

export interface JotPlate {
  chassis: ChassisView;
  /** Top-left of the plate, relative to the device's own top-left. */
  x: number;
  y: number;
  w: number;
  h: number;
  layout: FaceplateLayout;
  /** The device opened, which stays where the rack has it. */
  isDevice: boolean;
}

/** The device as a ChassisView, wherever it sits: rack, shelf, or free. */
export function deviceChassis(view: ClosetView, id: string): ChassisView | undefined {
  const racked = findChassis(view, id)?.chassis ?? findUnplacedChassis(view, id);
  if (racked) return racked;
  const occ = findOccupant(view, id)?.occupant;
  if (!occ || occ.kind !== 'chassis') return undefined;
  return {
    id: occ.id,
    deviceId: '',
    hostname: occ.label,
    model: occ.model ?? '',
    vendor: '',
    positionU: 0,
    heightU: 1,
    face: 'front',
    ports: occ.ports,
    role: null,
    managementAddress: null,
    serial: null,
    psuInlets: [],
    singleFed: false,
    oneFitted: false,
    placement: { kind: 'none' },
    sketch: occ.sketch,
  };
}

function plateOf(chassis: ChassisView, x: number, y: number, isDevice: boolean): JotPlate {
  const name = chassis.hostname || 'unnamed';
  // A device with few ports gets a taller plate so its ports read well when drawn large.
  const heightU = Math.max(chassis.heightU, isDevice ? 2 : 1);
  return { chassis, x, y, w: PLATE_W, h: heightU * U_PX, layout: faceplateLayoutFor(chassis.ports, heightU, name), isDevice };
}

function otherEnd(cable: CableView, chassisId: string): string | null {
  const ends = cable.ends.filter((e): e is { portId: string; chassisId: string; rackId: string | null } => 'portId' in e);
  if (ends.length !== 2 || !ends.some((e) => e.chassisId === chassisId)) return null;
  return ends.find((e) => e.chassisId !== chassisId)?.chassisId ?? null;
}

/**
 * The plates to draw: the device at the origin, then free boxes near it on the canvas or cabled to it.
 * `origin` is the device's own place on the canvas, in flow units; a free-box device uses its pin.
 */
export function jotPlates(view: ClosetView, deviceId: string, origin: { x: number; y: number }): JotPlate[] | null {
  const device = deviceChassis(view, deviceId);
  if (!device) return null;
  const pinOfDevice = view.free.find((f) => f.id === deviceId);
  const o = pinOfDevice ? { x: pinOfDevice.x, y: pinOfDevice.y } : origin;
  const plates: JotPlate[] = [plateOf(device, 0, 0, true)];
  const cabled = new Set(view.cables.map((c) => otherEnd(c, deviceId)).filter((id): id is string => id !== null));
  for (const box of view.free) {
    if (box.id === deviceId) continue;
    const dx = box.x - o.x;
    const dy = box.y - o.y;
    if (!cabled.has(box.id) && (Math.abs(dx) > NEAR || Math.abs(dy) > NEAR)) continue;
    const chassis = findUnplacedChassis(view, box.id);
    if (chassis) plates.push(plateOf(chassis, dx, dy, false));
  }
  return plates;
}

/** The device's place on the canvas, for turning stage positions back into pins. */
export function originOf(view: ClosetView, deviceId: string, at: { x: number; y: number } | null): { x: number; y: number } {
  const pin = view.free.find((f) => f.id === deviceId);
  return pin ? { x: pin.x, y: pin.y } : (at ?? { x: 0, y: 0 });
}

/** A free place beside the device for the next box, stacked down the right side. */
export function jotSpot(plates: readonly JotPlate[]): { x: number; y: number } {
  const taken = plates.map((p) => ({ x: p.x, y: p.y - NAME_PX, w: p.w, h: p.h + NAME_PX }));
  const x = PLATE_W + 48;
  for (let i = 0; i < 200; i += 1) {
    const y = i * (BOX_H + 24);
    if (!taken.some((t) => x < t.x + t.w && x + PLATE_W > t.x && y - NAME_PX < t.y + t.h && y + BOX_H > t.y)) return { x, y };
  }
  return { x, y: 0 };
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function boundsOf(plates: readonly JotPlate[]): Bounds {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of plates) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y - NAME_PX);
    x1 = Math.max(x1, p.x + p.w);
    y1 = Math.max(y1, p.y + p.h + 16);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Centre of a port on its plate, in stage units. */
export function portCentre(plate: JotPlate, portId: string): { x: number; y: number } | null {
  const box = plate.layout.byId.get(portId);
  return box ? { x: plate.x + box.x + box.w / 2, y: plate.y + box.y + box.h / 2 } : null;
}

export { BOX_W };
