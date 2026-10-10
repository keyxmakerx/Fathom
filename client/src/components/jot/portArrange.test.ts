import { describe, expect, it } from 'vitest';

import { PLATE_GRID, snapPort, toPlate } from './portArrange';

const plate = { w: 244, h: 32 };
const size = { w: 10, h: 10 };

describe('dragging a port on its plate', () => {
  it('snaps to the grid when nothing is close', () => {
    const s = snapPort({ cx: 101.3, cy: 14.9 }, size, plate, []);
    expect(s).toEqual({ cx: 100, cy: 16, guides: { v: [], h: [] } });
    expect(s.cx % PLATE_GRID).toBe(0);
  });

  it('lines up with another port close by, and shows the guide', () => {
    const s = snapPort({ cx: 61.5, cy: 21 }, size, plate, [{ id: 'a', cx: 63, cy: 9 }]);
    expect(s.cx).toBe(63);
    expect(s.guides.v).toEqual([63]);
    expect(s.guides.h).toEqual([]);
  });

  it('prefers the nearest of two lines', () => {
    const s = snapPort({ cx: 50, cy: 16 }, size, plate, [
      { id: 'a', cx: 52, cy: 0 },
      { id: 'b', cx: 49, cy: 0 },
    ]);
    expect(s.cx).toBe(49);
  });

  it('keeps the whole port on the plate', () => {
    expect(snapPort({ cx: -40, cy: 99 }, size, plate, [])).toMatchObject({ cx: 5, cy: 27 });
    expect(snapPort({ cx: 400, cy: -3 }, size, plate, [])).toMatchObject({ cx: 239, cy: 5 });
  });

  it('turns a plate spot into thousandths, clamped', () => {
    expect(toPlate(122, 16, plate)).toEqual({ x: 500, y: 500 });
    expect(toPlate(-5, 64, plate)).toEqual({ x: 0, y: 1000 });
  });
});
