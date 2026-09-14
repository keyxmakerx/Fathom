import { classes, frame, svgSize, type PortGlyphProps } from './types';

/** LC — two ferrules in a frame. Legend board, true size 24×14. The frame
 * never fills; the ferrules carry the state. */
const BOX = frame(24, 14);

export function Lc({ cabled, scale = 1, title, className }: PortGlyphProps) {
  return (
    <svg
      className={classes('lc', cabled, className)}
      viewBox={BOX.viewBox}
      {...svgSize(BOX, scale)}
      role="img"
      aria-label={title ?? (cabled ? 'LC, cabled' : 'LC, free')}
    >
      <rect className="port__edge" vectorEffect="non-scaling-stroke" x="0" y="0" width="24" height="14" />
      <circle className="port__body" vectorEffect="non-scaling-stroke" cx="7" cy="7" r="3.2" />
      <circle className="port__body" vectorEffect="non-scaling-stroke" cx="17" cy="7" r="3.2" />
    </svg>
  );
}
