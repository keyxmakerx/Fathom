import { describe, expect, it } from 'vitest';

import { LEADER_PX, cardAnchor, placeCard } from './quickCardPlace';

const box = { left: 100, right: 300, top: 50, width: 200, height: 20 };
const at = { fx: 0.25, fy: 0.75 };

describe('where the quick card hangs', () => {
  it('hangs off the right edge of a device, a shelf or a port, half way down it', () => {
    for (const kind of ['device', 'shelf', 'port'] as const) {
      expect(cardAnchor(kind, at, box)).toEqual({ y: 60, left: 100, right: 300 });
    }
  });

  it('hangs off a rack at the height it was clicked, a rack being tall', () => {
    expect(cardAnchor('rack', at, { ...box, height: 400 })).toEqual({ y: 350, left: 100, right: 300 });
  });

  it('hangs off a cable where it was clicked', () => {
    expect(cardAnchor('cable', at, box)).toEqual({ y: 65, left: 150, right: 150 });
  });

  it('hangs off the end of the shelf for a thing on it, so that it does not lie on the things beside it', () => {
    const chip = { left: 140, right: 180, top: 52, width: 40, height: 16 };
    expect(cardAnchor('device', at, chip, { left: 100, right: 300 })).toEqual({ y: 60, left: 100, right: 300 });
    // Opened beside the shelf, the row reaches as far as the opened box.
    expect(cardAnchor('device', at, chip, { left: 100, right: 520 })).toEqual({ y: 60, left: 100, right: 520 });
  });

  it('hangs off the end of the device for a port on it, with the line still starting at the port', () => {
    const port = { left: 140, right: 160, top: 52, width: 20, height: 16 };
    expect(cardAnchor('port', at, port, { left: 100, right: 600 })).toEqual({ y: 60, left: 100, right: 600, from: { left: 140, right: 160 } });
  });

  it('gives a rack, a shelf and a cable no row', () => {
    for (const kind of ['rack', 'shelf', 'cable'] as const) {
      expect(cardAnchor(kind, at, box, { left: 0, right: 900 })).toEqual(cardAnchor(kind, at, box));
    }
  });
});

describe('where the quick card is put', () => {
  const canvas = { left: 0, right: 1400, top: 60, bottom: 900 };
  const card = { w: 240, h: 200 };
  const thing = (left: number, right: number, y = 400) => ({ y, left, right });

  it('goes right of the thing, level with it, joined by the dotted line', () => {
    expect(placeCard(thing(500, 900), card, canvas)).toEqual({ ax: 900, ay: 400, bx: 900 + LEADER_PX, left: 900 + LEADER_PX, top: 300, hidden: false });
  });

  it('goes left of the thing when the canvas has no room on the right', () => {
    expect(placeCard(thing(700, 1300), card, canvas)).toEqual({ ax: 700, ay: 400, bx: 700 - LEADER_PX, left: 700 - LEADER_PX - 240, top: 300, hidden: false });
  });

  it('is still shown, on the left, when the right end of the thing is past the edge of the canvas', () => {
    const placed = placeCard(thing(1124, 1612), card, canvas);
    expect(placed.hidden).toBe(false);
    expect(placed.ax).toBe(1124);
    expect(placed.left).toBe(1124 - LEADER_PX - 240);
  });

  it('is hidden when the end its line starts from is out of view, or the thing is above or below the canvas', () => {
    expect(placeCard(thing(-900, -100), card, canvas).hidden).toBe(true);
    expect(placeCard(thing(-200, 1600), card, canvas).hidden).toBe(true);
    expect(placeCard(thing(500, 900, 20), card, canvas).hidden).toBe(true);
    expect(placeCard(thing(500, 900, 950), card, canvas).hidden).toBe(true);
  });

  it('is hidden while the thing is dragged', () => {
    expect(placeCard(thing(500, 900), card, canvas, true).hidden).toBe(true);
  });

  it('stays inside the canvas from top to bottom, and never left of its edge', () => {
    expect(placeCard(thing(500, 900, 80), card, canvas).top).toBe(68);
    expect(placeCard(thing(500, 900, 880), card, canvas).top).toBe(900 - 200 - 8);
    expect(placeCard(thing(100, 1300), card, canvas).left).toBe(8);
  });

  describe('for a port', () => {
    const port = (left: number, device: [number, number]) => ({ y: 400, left: device[0], right: device[1], from: { left, right: left + 20 } });

    it('goes right of the device, clear of every port on it, and its line runs back to the port', () => {
      expect(placeCard(port(540, [500, 900]), card, canvas)).toEqual({ ax: 560, ay: 400, bx: 900 + LEADER_PX, left: 900 + LEADER_PX, top: 300, hidden: false });
    });

    it('goes left of the device when the canvas has no room on the right, the line starting at the left of the port', () => {
      expect(placeCard(port(1200, [700, 1300]), card, canvas)).toEqual({ ax: 1200, ay: 400, bx: 700 - LEADER_PX, left: 700 - LEADER_PX - 240, top: 300, hidden: false });
    });

    it('stays beside the port itself when the device has room on neither side', () => {
      // The device runs past both edges of the canvas.
      expect(placeCard(port(600, [-200, 1600]), card, canvas)).toEqual({ ax: 620, ay: 400, bx: 620 + LEADER_PX, left: 620 + LEADER_PX, top: 300, hidden: false });
      // No room right of the port either: left of it.
      expect(placeCard(port(1300, [-200, 1600]), card, canvas)).toEqual({ ax: 1300, ay: 400, bx: 1300 - LEADER_PX, left: 1300 - LEADER_PX - 240, top: 300, hidden: false });
      // The device fills the canvas from edge to edge without passing it.
      expect(placeCard(port(600, [100, 1300]), card, canvas).left).toBe(620 + LEADER_PX);
    });

    it('is hidden when the port is out of view, though its device is not', () => {
      expect(placeCard(port(-60, [-100, 900]), card, canvas).hidden).toBe(true);
      expect(placeCard(port(1450, [700, 1500]), card, canvas).hidden).toBe(true);
    });
  });
});
