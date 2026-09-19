import { classes, frame, svgSize, type PortGlyphProps } from './types';

/** C14 — hex inlet, three pins. Legend board, true size 22×16. The inlet
 * never fills; the pins carry the state. */
const BOX = frame(22, 16);

export function C14({ cabled, scale = 1, title, className }: PortGlyphProps) {
  return (
    <svg
      className={classes('c14', cabled, className)}
      viewBox={BOX.viewBox}
      {...svgSize(BOX, scale)}
      role="img"
      aria-label={title ?? (cabled ? 'C14, fed' : 'C14, free')}
    >
      <path
        className="port__edge"
        vectorEffect="non-scaling-stroke"
        d="M0 4 L4 0 L18 0 L22 4 L22 12 L18 16 L4 16 L0 12 Z"
      />
      <circle className="port__body" vectorEffect="non-scaling-stroke" cx="6" cy="10" r="1.4" />
      <circle className="port__body" vectorEffect="non-scaling-stroke" cx="16" cy="10" r="1.4" />
      <rect className="port__body" vectorEffect="non-scaling-stroke" x="9.8" y="3" width="2.4" height="4" />
    </svg>
  );
}
