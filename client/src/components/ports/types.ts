/** The five port glyphs of `docs/UI-SPEC.md` "Ports". One interface, one
 * size rule: `scale` 1 is the Legend board's true size, which is also the
 * size the Faceplate board draws every port at. Nothing here takes a
 * colour — a port glyph is ink on page, never a sheath. */

export type PortKind = 'rj45' | 'sfp-plus' | 'lc' | 'c14' | 'qsfp-plus';

export interface PortGlyphProps {
  /** Filled = cabled, hollow = free. */
  cabled: boolean;
  /** Multiplier on the true size. 1 = faceplate zoom. */
  scale?: number;
  /** Accessible name, e.g. the port's label from the catalogue. */
  title?: string;
  className?: string;
}

export interface GlyphBox {
  viewBox: string;
  width: number;
  height: number;
}

/** Geometry is drawn on integer units with the viewBox offset by half a
 * unit, so at scale 1 every hairline is centred on a pixel row or column
 * and renders as one crisp pixel. Strokes are non-scaling, so the hairline
 * stays 1px at every zoom, per "Look". `above` is room for anything that
 * rises over the top edge, such as the SFP+ bail. */
export function frame(width: number, height: number, above = 0): GlyphBox {
  return {
    viewBox: `-0.5 ${-above - 0.5} ${width + 1} ${height + above + 1}`,
    width: width + 1,
    height: height + above + 1,
  };
}

export function svgSize(box: GlyphBox, scale: number) {
  return { width: box.width * scale, height: box.height * scale };
}

export function classes(kind: PortKind, cabled: boolean, extra?: string) {
  return ['port', `port--${kind}`, cabled ? 'port--cabled' : 'port--free', extra]
    .filter(Boolean)
    .join(' ');
}
