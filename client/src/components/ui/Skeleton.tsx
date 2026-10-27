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

/**
 * Where the drawing will be: an empty canvas, and after a beat one quiet line.
 * It once drew grey rack outlines, and a design that took just over the wait
 * flashed "rows of racks" that were not the person's (owner, 2026-10-26): a
 * placeholder shaped like content reads as content. Text cannot be mistaken.
 */
export function SkeletonRacks({ label = 'Opening the design…' }: { label?: string }) {
  return (
    <div className="skeleton skeleton--racks" role="status" aria-busy="true" aria-live="polite">
      <span className="skeleton__line">{label}</span>
    </div>
  );
}
