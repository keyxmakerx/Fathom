import type { LiveStatus } from './useDesignSession';
import './liveNotices.css';

interface Props {
  live: LiveStatus;
  onKeepTheirs: () => void;
  onPutMineBack: (id: string) => void;
  onDismissNote: () => void;
}

const TAIL = ' just after you';

/** "<b>Bob changed the serial on core-sw-01</b> just after you" */
function Line({ text }: { text: string }) {
  const at = text.endsWith(TAIL) ? text.length - TAIL.length : text.length;
  return (
    <span className="live-notice__line">
      <b>{text.slice(0, at)}</b>
      {text.slice(at)}
    </span>
  );
}

/** The live design's lines (ADR-0063): "<who> changed <field> on <device> just after you", a merge
 * reassurance, a dropped change, a dropped connection. The status region is always there; only its
 * children come and go. Shell puts it under the field in the editor, or at the canvas's top right. */
export function LiveNotices({ live, onKeepTheirs, onPutMineBack, onDismissNote }: Props) {
  const down = live.mode !== 'legacy' && live.reconnecting;
  const o = live.overwrite;
  return (
    <div className="live-notices" role="status" aria-live="polite">
      {o != null && (
        <div className="live-notice live-notice--ink" data-testid="live-overwrite">
          {o.lines.map((line) => (
            <Line key={line} text={line} />
          ))}
          {o.items.length === 1 ? (
            <>
              <span className="live-notice__mono">{o.items[0].yours}</span>
              <span className="live-notice__buttons">
                <button type="button" className="live-notice__btn" onClick={onKeepTheirs}>
                  {o.keep}
                </button>
                <button type="button" className="live-notice__btn" onClick={() => onPutMineBack(o.items[0].id)}>
                  Put mine back
                </button>
              </span>
            </>
          ) : (
            <>
              {o.items.map((item) => (
                <span className="live-notice__item" key={item.id}>
                  <span className="live-notice__mono">{item.yours}</span>
                  <button type="button" className="live-notice__btn" onClick={() => onPutMineBack(item.id)}>
                    Put mine back
                  </button>
                </span>
              ))}
              <span className="live-notice__buttons">
                <button type="button" className="live-notice__btn" onClick={onKeepTheirs}>
                  {o.keep}
                </button>
              </span>
            </>
          )}
        </div>
      )}
      {live.merged != null && (
        <span className="live-notice__muted" data-testid="live-merged">
          {live.merged}
        </span>
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
        <span className="live-notice__muted" data-testid="live-down">
          Reconnecting; your changes are kept.
        </span>
      )}
    </div>
  );
}
