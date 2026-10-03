import { useContext } from 'react';
import { CheckMarksContext, useCheckBadge } from './checksStore';
import './checks.css';

const label = (n: number): string => `${n} ${n === 1 ? 'check' : 'checks'}`;

/** A count at the top-right corner of a device plate or box. `id` is the device's, chassis's or port's id. */
export function CheckBadge({ id }: { id: string }) {
  const n = useCheckBadge(id);
  const on = useContext(CheckMarksContext);
  if (n === 0 || !on) return null;
  return (
    <span className="checks-badge" title={label(n)} aria-label={label(n)} data-testid="checks-badge">
      {n}
    </span>
  );
}

/** The same on a cable, inside the edge's own SVG, at its midpoint. */
export function CableCheckBadge({ id, x, y }: { id: string; x: number; y: number }) {
  const n = useCheckBadge(id);
  const on = useContext(CheckMarksContext);
  if (n === 0 || !on) return null;
  const w = n > 9 ? 20 : 16;
  return (
    <g className="checks-cable-badge" transform={`translate(${x} ${y})`} data-testid="checks-cable-badge">
      <title>{label(n)}</title>
      <rect x={-w / 2} y={-8} width={w} height={16} />
      <text>{n}</text>
    </g>
  );
}
