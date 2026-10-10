import type { CSSProperties } from 'react';

import './feedback.css';

/** The words screen readers hear (and browser-drive scripts wait for) while soft shapes show. */
function Said({ label }: { label: string }) {
  return <span className="skeleton__said">{label}</span>;
}

export interface SkeletonRowsProps {
  /** What is loading, said aloud and kept as hidden text: "Loading…". */
  label?: string;
  rows?: number;
  className?: string;
}

/** Soft grey rows with a slow shimmer, where a list will be. */
export function SkeletonRows({ label = 'Loading…', rows = 4, className }: SkeletonRowsProps) {
  return (
    <div className={`skeleton skeleton--rows${className ? ` ${className}` : ''}`} role="status" aria-busy="true" aria-live="polite">
      <Said label={label} />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton__row" aria-hidden="true">
          <span className="skeleton__bar" style={{ width: `${70 - ((i * 13) % 30)}%` } as CSSProperties} />
          <span className="skeleton__bar skeleton__bar--short" />
        </div>
      ))}
    </div>
  );
}

/** A few rack outlines on the canvas, where the drawing will be. */
export function SkeletonRacks({ label = 'Opening the design…' }: { label?: string }) {
  const heights = [78, 96, 64, 88];
  return (
    <div className="skeleton skeleton--racks" role="status" aria-busy="true" aria-live="polite">
      <Said label={label} />
      <div className="skeleton__racks" aria-hidden="true">
        {heights.map((h, i) => (
          <div key={i} className="skeleton__rack" style={{ height: `${h}%`, animationDelay: `${i * 120}ms` } as CSSProperties}>
            {Array.from({ length: 5 }, (_, j) => (
              <span key={j} className="skeleton__unit" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
