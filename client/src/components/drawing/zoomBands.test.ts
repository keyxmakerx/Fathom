import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CAMERA_STOPS, ZOOM_BANDS, portOpacity, zoomBandAt } from './geometry';

const CSS = readFileSync(fileURLToPath(new URL('../../styles/drawing.css', import.meta.url)), 'utf8');

describe('zoomBandAt', () => {
  it('names the band by its lower bound, the lowest band taking everything below it', () => {
    expect(zoomBandAt(10)).toBe(50);
    expect(zoomBandAt(77.4)).toBe(50);
    expect(zoomBandAt(77.5)).toBe(77.5);
    expect(zoomBandAt(99)).toBe(77.5);
    expect(zoomBandAt(149)).toBe(125);
    expect(zoomBandAt(330)).toBe(300);
  });

  it('puts the rack, faceplate and inside stops at the bottom of their own bands', () => {
    for (const stop of [CAMERA_STOPS.rack, CAMERA_STOPS.faceplate, CAMERA_STOPS.inside]) expect(zoomBandAt(stop)).toBe(stop);
  });

  it('drawing.css sets --zoom and --zoom-pct for every band', () => {
    for (const band of ZOOM_BANDS) {
      const rule = new RegExp(`\\.drawing\\[data-zoom-band='${band}'\\]\\s*\\{\\s*--zoom:\\s*${band / 100};\\s*--zoom-pct:\\s*${band};\\s*\\}`);
      expect(CSS, `band ${band}`).toMatch(rule);
    }
  });

  // A port that is not drawn keeps its place, so its cable still ends there, and is out of reach. `ChassisNode.tsx`
  // and `SurfaceNode.tsx` put the mark on below the 125 band (`Drawing.tsx`), which is where a port's opacity is 0.
  it('drawing.css puts an undrawn port out of reach, in a rack and on a wall', () => {
    expect(CSS).toMatch(/\.drawing-chassis__ports--undrawn\s*\{\s*visibility:\s*hidden;\s*\}/);
    expect(CSS).toMatch(/\.drawing-surface__port-row--undrawn\s*\{\s*visibility:\s*hidden;\s*\}/);
  });

  it('ports are at opacity 0 in exactly the bands below 125, where they are marked undrawn', () => {
    for (const band of ZOOM_BANDS) expect(portOpacity(band) === 0, `band ${band}`).toBe(band < 125);
  });
});
