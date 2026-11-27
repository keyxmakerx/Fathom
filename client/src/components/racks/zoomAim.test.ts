import { describe, expect, it } from 'vitest';

import { AIM_INSET_PX, RACK_ROOM_PX, aimAt, cameraOnto, cameraOntoRack, unionBox, type Box, type Camera } from './zoomAim';

const pane = { width: 1000, height: 800 };

describe('where a zoom stop lands', () => {
  it('lands on the middle of what is selected, wherever the view was', () => {
    expect(aimAt(pane, { left: 100, top: 40, width: 200, height: 20 }, [{ left: 480, top: 380, width: 40, height: 40 }])).toEqual({ x: 200, y: 50 });
  });

  it('with nothing selected and something under the middle, zooms about the middle', () => {
    expect(aimAt(pane, null, [{ left: 300, top: 100, width: 400, height: 600 }])).toEqual({ x: 500, y: 400 });
  });

  it('with the middle on empty paper, moves to the nearest thing, a little inside its edge', () => {
    // A tall rack to the right of the middle: the stop lands just inside its near edge, level with the view.
    expect(aimAt(pane, null, [{ left: 700, top: 0, width: 200, height: 800 }, { left: 0, top: 0, width: 50, height: 50 }])).toEqual({ x: 700 + AIM_INSET_PX, y: 400 });
  });

  it('lands on the middle of a nearby thing too small to step inside', () => {
    expect(aimAt(pane, null, [{ left: 600, top: 500, width: 60, height: 18 }])).toEqual({ x: 630, y: 509 });
  });

  it('stays where it is on an empty drawing', () => {
    expect(aimAt(pane, null, [])).toEqual({ x: 500, y: 400 });
  });

  it('takes several selected things as one box', () => {
    expect(unionBox([{ left: 10, top: 10, width: 10, height: 10 }, { left: 100, top: 50, width: 20, height: 30 }])).toEqual({ left: 10, top: 10, width: 110, height: 70 });
    expect(unionBox([])).toBeNull();
  });
});

describe('the camera for a stop', () => {
  it('brings the spot to the middle of the pane at the new zoom', () => {
    // At 100% with the paper moved by (50, 20), the pane spot (250, 120) is the paper point (200, 100).
    const camera = cameraOnto({ x: 50, y: 20, zoom: 1 }, pane, { x: 250, y: 120 }, 2);
    expect(camera).toEqual({ x: 500 - 200 * 2, y: 400 - 100 * 2, zoom: 2 });
    // That paper point is now in the middle.
    expect({ x: 200 * camera.zoom + camera.x, y: 100 * camera.zoom + camera.y }).toEqual({ x: 500, y: 400 });
  });

  it('about the middle, it is the plain zoom the stops always did', () => {
    const from = { x: -120, y: 64, zoom: 0.875 };
    const camera = cameraOnto(from, pane, { x: 500, y: 400 }, 1);
    const cx = (500 - from.x) / from.zoom;
    const cy = (400 - from.y) / from.zoom;
    expect(camera.x).toBeCloseTo(500 - cx);
    expect(camera.y).toBeCloseTo(400 - cy);
  });
});

describe('the Rack stop, going in from the closet', () => {
  // The whole closet at 50%, with the tool row 40 into the pane's top and the zoom buttons 50 into its foot.
  const from: Camera = { x: 0, y: 0, zoom: 0.5 };
  const reach = { top: 40, bottom: 50 };
  const top = reach.top + RACK_ROOM_PX;
  const room = pane.height - reach.bottom - RACK_ROOM_PX - top;
  /** Where a box drawn at `from` is on the pane under `camera`. */
  const under = (camera: Camera, box: Box): Box => {
    const k = camera.zoom / from.zoom;
    return { left: ((box.left - from.x) / from.zoom) * camera.zoom + camera.x, top: ((box.top - from.y) / from.zoom) * camera.zoom + camera.y, width: box.width * k, height: box.height * k };
  };

  it('lands on the rack, in the middle of the room between the tool row and the zoom buttons', () => {
    // The middle of the view is a wall; the rack is up in a corner.
    const rack = { left: 100, top: 100, width: 150, height: 104 };
    const camera = cameraOntoRack(from, pane, [rack], 1, reach)!;
    expect(camera.zoom).toBe(1);
    const seen = under(camera, rack);
    expect(seen.left + seen.width / 2).toBeCloseTo(pane.width / 2);
    expect(seen.top + seen.height / 2).toBeCloseTo(top + room / 2);
  });

  it('picks the rack nearest the middle of the view', () => {
    const far = { left: 20, top: 20, width: 150, height: 104 };
    const near = { left: 600, top: 300, width: 150, height: 104 };
    const seen = under(cameraOntoRack(from, pane, [far, near], 1, reach)!, near);
    expect(seen.left + seen.width / 2).toBeCloseTo(pane.width / 2);
  });

  it('shows the top of a rack too tall for the room', () => {
    // Twice the size it is 780 tall and the room is 678. It lies above the middle of the view.
    const rack = { left: 400, top: 0, width: 150, height: 390 };
    const seen = under(cameraOntoRack(from, pane, [rack], 1, reach)!, rack);
    expect(seen.top).toBeCloseTo(top);
    expect(seen.left + seen.width / 2).toBeCloseTo(pane.width / 2);
  });

  it('keeps the part of a tall rack the middle of the view was on', () => {
    // The middle of the view (500, 400) is 250 down this rack: twice the size, that is 500 down, in the room's middle.
    const rack = { left: 400, top: 150, width: 150, height: 500 };
    const seen = under(cameraOntoRack(from, pane, [rack], 1, reach)!, rack);
    expect(seen.top + 500).toBeCloseTo(top + room / 2);
    // Level with the middle but off to one side, the rack was not being looked at: its top.
    const aside = { ...rack, left: 100 };
    expect(under(cameraOntoRack(from, pane, [aside], 1, reach)!, aside).top).toBeCloseTo(top);
  });

  it('and leaves no paper above its top or under its foot', () => {
    // On a part near its top: the rack's top stays at the top of the room.
    const high = { left: 400, top: 380, width: 150, height: 500 };
    expect(under(cameraOntoRack(from, pane, [high], 1, reach)!, high).top).toBeCloseTo(top);
    // On a part near its foot: the foot stays at the foot of the room.
    const low = { left: 400, top: -80, width: 150, height: 500 };
    const seen = under(cameraOntoRack(from, pane, [low], 1, reach)!, low);
    expect(seen.top + seen.height).toBeCloseTo(top + room);
  });

  it('answers nothing with no rack drawn', () => {
    expect(cameraOntoRack(from, pane, [], 1, reach)).toBeNull();
  });
});
