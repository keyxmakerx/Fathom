import type { LiveStatus } from './useDesignSession';
import './liveNotices.css';

interface Props {
  live: LiveStatus;
  onKeepTheirs: () => void;
  onPutMineBack: () => void;
  onDismissNote: () => void;
}

/** The live design's quiet lines (ADR-0063): a dropped connection, a change
 * that was left out, and "<who> changed <field> just after you". */
export function LiveNotices({ live, onKeepTheirs, onPutMineBack, onDismissNote }: Props) {
  const down = live.mode !== 'legacy' && live.reconnecting;
  if (!down && live.note == null && live.overwrite == null) return null;
  return (
    <div className="live-notices" role="status" aria-live="polite">
      {live.overwrite != null && (
        <div className="live-notice" data-testid="live-overwrite">
          <span className="live-notice__text">{live.overwrite.sentence}</span>
          <button type="button" className="shell-chip shell-chip--ink" onClick={onKeepTheirs}>
            Keep theirs
          </button>
          <button type="button" className="shell-chip shell-chip--ink" onClick={onPutMineBack}>
            Put mine back
          </button>
        </div>
      )}
      {live.note != null && (
        <div className="live-notice" data-testid="live-note">
          <span className="live-notice__text">{live.note}</span>
          <button type="button" className="live-notice__close" aria-label="Dismiss" onClick={onDismissNote}>
            ×
          </button>
        </div>
      )}
      {down && (
        <div className="live-notice live-notice--quiet" data-testid="live-down">
          Reconnecting; your changes are kept.
        </div>
      )}
    </div>
  );
}
