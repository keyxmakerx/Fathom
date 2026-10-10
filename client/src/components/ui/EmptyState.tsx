import type { ReactNode } from 'react';

import './feedback.css';

export interface EmptyStateProps {
  /** The short line: what is empty ("No changes yet."). */
  title: string;
  /** One sentence on what belongs here, or how to get it. */
  children?: ReactNode;
  /** The one button that adds it, wired to something that already exists. Absent where nothing fits. */
  action?: { label: string; onClick: () => void; disabled?: boolean };
  /** Keeps a place's own class on the box, so its spacing and tests still find it. */
  className?: string;
  /** A tighter box for narrow panels and table bodies. */
  compact?: boolean;
}

/** An empty panel that says what to do: a title, one sentence, and the one button that adds the
 * first thing. Used in place of a bare "Nothing here" wherever an action exists to offer. */
export function EmptyState({ title, children, action, className, compact }: EmptyStateProps) {
  return (
    <div className={`empty-state${compact ? ' empty-state--compact' : ''}${className ? ` ${className}` : ''}`}>
      <div className="empty-state__title">{title}</div>
      {children != null && <p className="empty-state__text">{children}</p>}
      {action != null && (
        <button type="button" className="empty-state__action" onClick={action.onClick} disabled={action.disabled}>
          {action.label}
        </button>
      )}
    </div>
  );
}
