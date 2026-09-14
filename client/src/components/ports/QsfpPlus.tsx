import { classes, frame, svgSize, type PortGlyphProps } from './types';

/** QSFP+ — a wide cage with four lanes. True size 40×13: the same height as
 * an SFP+ cage, wider in the real proportion (18.35 mm against 13.4 mm).
 *
 * What makes it unmistakable in isolation is not the width — with nothing
 * beside it a reader cannot compare widths — but the direction of the rule
 * inside the cage. An SFP+ carries one horizontal rule across its mouth: one
 * slot. A QSFP+ carries three vertical rules: four lanes. Orientation reads
 * without a neighbour and survives the smallest zoom, in both states,
 * because the dividers are the longest lines in the glyph. There is no
 * bail — a QSFP+ module has a pull tab, not a wire latch, and leaving the
 * top edge flat is what keeps the silhouette from being "SFP+ but bigger". */
const BOX = frame(40, 13);

export function QsfpPlus({ cabled, scale = 1, title, className }: PortGlyphProps) {
  return (
    <svg
      className={classes('qsfp-plus', cabled, className)}
      viewBox={BOX.viewBox}
      {...svgSize(BOX, scale)}
      role="img"
      aria-label={title ?? (cabled ? 'QSFP+, cabled' : 'QSFP+, free')}
    >
      <rect className="port__body" vectorEffect="non-scaling-stroke" x="0" y="0" width="40" height="13" />
      <path className="port__inner" vectorEffect="non-scaling-stroke" d="M10 0 V13 M20 0 V13 M30 0 V13" />
    </svg>
  );
}
