import { classes, frame, svgSize, type PortGlyphProps } from './types';

/** Generic — a plain square, for a connector none of the five named glyphs
 * fits. Legend board, true size 16×16. */
const BOX = frame(16, 16);

export function Generic({ cabled, scale = 1, title, className }: PortGlyphProps) {
  return (
    <svg
      className={classes('generic', cabled, className)}
      viewBox={BOX.viewBox}
      {...svgSize(BOX, scale)}
      role="img"
      aria-label={title ?? (cabled ? 'port, cabled' : 'port, free')}
    >
      <rect className="port__body" vectorEffect="non-scaling-stroke" x="0" y="0" width="16" height="16" />
    </svg>
  );
}
