import { describe, expect, it } from 'vitest';

import { AIM_INSET_PX, aimAt, cameraOnto, unionBox } from './zoomAim';

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
