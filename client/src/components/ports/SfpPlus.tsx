import { classes, frame, svgSize, type PortGlyphProps } from './types';

/** SFP+ — a flat cage with a bail. Legend board, true size 28×13, the
 * bail rising 3 above the cage. One horizontal rule across the mouth. */
const BOX = frame(28, 13, 3);

export function SfpPlus({ cabled, scale = 1, title, className }: PortGlyphProps) {
  return (
    <svg
      className={classes('sfp-plus', cabled, className)}
      viewBox={BOX.viewBox}
      {...svgSize(BOX, scale)}
      role="img"
      aria-label={title ?? (cabled ? 'SFP+, cabled' : 'SFP+, free')}
    >
      <rect className="port__body" vectorEffect="non-scaling-stroke" x="0" y="0" width="28" height="13" />
      <line className="port__inner" vectorEffect="non-scaling-stroke" x1="0" y1="6.5" x2="28" y2="6.5" />
      <path className="port__edge" vectorEffect="non-scaling-stroke" d="M3 0 L3 -3 L11 -3 L11 0" />
    </svg>
  );
}
