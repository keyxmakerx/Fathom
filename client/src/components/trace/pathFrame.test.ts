import { describe, expect, it } from 'vitest';

import { READABLE_ZOOM } from '../drawing/geometry';
import { PATH_MAX_ZOOM, PATH_MIN_ZOOM, around, pathCamera, sameCamera, type Box, type PathRoom } from './pathFrame';

// Two of the sample home lab's paths at the size the page draws them (a camera to the NAS inside one closet
// corner, the desktop to the NAS across the whole lab), and the pane beside the open trace panel at three windows.
const CAMERA_TO_NAS: Box = { x: 28, y: 12, width: 563, height: 121 };
const DESKTOP_TO_NAS: Box = { x: 28, y: 63, width: 1491, height: 700 };
const ROOM_1440: PathRoom = { width: 1096, height: 856, top: 39, bottom: 46 };
const ROOM_1366: PathRoom = { width: 1022, height: 724, top: 39, bottom: 46 };
const ROOM_1280: PathRoom = { width: 936, height: 676, top: 39, bottom: 46 };
const GAP = 12;

/** Where the camera puts a box, in pane pixels. */
function shown(box: Box, room: PathRoom) {
  const at = pathCamera(box, room);
  return { zoom: at.zoom, left: box.x * at.zoom + at.x, top: box.y * at.zoom + at.y, right: (box.x + box.width) * at.zoom + at.x, bottom: (box.y + box.height) * at.zoom + at.y };
}

describe('around', () => {
  it('is the smallest box round them all, and nothing for none', () => {
    expect(around([])).toBeNull();
    expect(around([{ x: 10, y: 20, width: 30, height: 5 }])).toEqual({ x: 10, y: 20, width: 30, height: 5 });
    expect(
      around([
        { x: 10, y: 20, width: 30, height: 5 },
        { x: -4, y: 22, width: 10, height: 40 },
        { x: 100, y: 0, width: 1, height: 1 },
      ]),
    ).toEqual({ x: -4, y: 0, width: 105, height: 62 });
  });
});

describe('pathCamera (a question frames its path)', () => {
  it('draws a short path no larger than the ceiling, in the middle between the tool row and the zoom buttons', () => {
    const at = shown(CAMERA_TO_NAS, ROOM_1440);
    expect(at.zoom).toBe(PATH_MAX_ZOOM);
    expect(Math.abs((at.left + at.right) / 2 - ROOM_1440.width / 2)).toBeLessThanOrEqual(1);
    expect(at.top).toBeGreaterThanOrEqual(ROOM_1440.top + GAP);
    expect(at.bottom).toBeLessThanOrEqual(ROOM_1440.height - ROOM_1440.bottom - GAP);
  });

  it('shows a path across the whole lab whole, where a name can still be read', () => {
    for (const room of [ROOM_1440, ROOM_1366]) {
      const at = shown(DESKTOP_TO_NAS, room);
      expect(at.zoom).toBeGreaterThanOrEqual(READABLE_ZOOM);
      expect(at.zoom).toBeLessThan(PATH_MAX_ZOOM);
      expect(at.left).toBeGreaterThanOrEqual(0);
      expect(at.right).toBeLessThanOrEqual(room.width);
      expect(at.top).toBeGreaterThanOrEqual(room.top + GAP - 1);
      expect(at.bottom).toBeLessThanOrEqual(room.height - room.bottom - GAP + 1);
    }
  });

  it('goes a little further out than a first view does, to show a path whole in a small window', () => {
    const at = shown(DESKTOP_TO_NAS, ROOM_1280);
    expect(at.zoom).toBeLessThan(READABLE_ZOOM);
    expect(at.zoom).toBeGreaterThanOrEqual(PATH_MIN_ZOOM);
    expect(at.left).toBeGreaterThanOrEqual(0);
    expect(at.right).toBeLessThanOrEqual(ROOM_1280.width);
    expect(at.top).toBeGreaterThanOrEqual(ROOM_1280.top + GAP - 1);
    expect(at.bottom).toBeLessThanOrEqual(ROOM_1280.height - ROOM_1280.bottom - GAP + 1);
  });

  it('goes no further out than its floor, and keeps a path too large for that in the middle', () => {
    const wide = shown({ x: 0, y: 0, width: 4000, height: 300 }, ROOM_1280);
    expect(wide.zoom).toBe(PATH_MIN_ZOOM);
    expect(Math.abs((wide.left + wide.right) / 2 - ROOM_1280.width / 2)).toBeLessThanOrEqual(1);
  });

  it('frames one device without dividing by nothing', () => {
    const at = pathCamera({ x: 300, y: 200, width: 0, height: 0 }, ROOM_1440);
    expect(at.zoom).toBe(PATH_MAX_ZOOM);
    expect(Number.isFinite(at.x) && Number.isFinite(at.y)).toBe(true);
  });
});

describe('sameCamera', () => {
  it('is true to the pixel and false once the view has moved', () => {
    const at = { x: 120.2, y: -40, zoom: 0.669 };
    expect(sameCamera(at, { x: 120.9, y: -40.4, zoom: 0.6695 })).toBe(true);
    expect(sameCamera(at, { ...at, x: 124 })).toBe(false);
    expect(sameCamera(at, { ...at, zoom: 0.7 })).toBe(false);
  });
});
