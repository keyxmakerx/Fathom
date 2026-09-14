import { classes, frame, svgSize, type PortGlyphProps } from './types';

/** RJ45 — latch notch on top. Legend board, true size 22×20. */
const BOX = frame(22, 20);

export function Rj45({ cabled, scale = 1, title, className }: PortGlyphProps) {
  return (
    <svg
      className={classes('rj45', cabled, className)}
      viewBox={BOX.viewBox}
      {...svgSize(BOX, scale)}
      role="img"
      aria-label={title ?? (cabled ? 'RJ45, cabled' : 'RJ45, free')}
    >
      <path
        className="port__body"
        vectorEffect="non-scaling-stroke"
        d="M0 5 L0 20 L22 20 L22 5 L17 5 L17 0 L5 0 L5 5 Z"
      />
    </svg>
  );
}
