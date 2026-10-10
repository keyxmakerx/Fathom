import type { OverwritePart } from '../../document/liveDoc';
import type { LiveStatus } from './useDesignSession';
import './liveNotices.css';

interface Props {
  live: LiveStatus;
  onKeepTheirs: () => void;
  onPutMineBack: (id: string) => void;
  onDismissNote: () => void;
}

/** "<b>Bob changed the serial on <nowrap>core-sw-01</nowrap></b> just after you" */
function Line({ part }: { part: OverwritePart }) {
  return (
    <span className="live-notice__line">
      <b>
        {part.head} on <span className="live-notice__device">{part.on}</span>
      </b>
      {part.tail}
    </span>
  );
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Is there anything to show? */
export function hasLiveNotices(live: LiveStatus): boolean {
  return live.overwrite != null || live.merged != null || live.note != null || (live.mode !== 'legacy' && live.reconnecting);
}

/** What a screen reader is told, once, by the one status region the shell keeps mounted. */
export function announcement(live: LiveStatus): string {
  const out: string[] = [];
  if (live.overwrite != null) out.push(...live.overwrite.lines);
  if (live.merged != null) out.push(live.merged);
  if (live.note != null) out.push(live.note);
  if (live.mode !== 'legacy' && live.reconnecting) {
    out.push(live.stuck ? `Reconnecting; your changes are kept. Still trying. ${live.stuck}` : 'Reconnecting; your changes are kept.');
  }
  return out.join('. ');
}

/** The live design's lines (ADR-0063), drawn where they belong: under the field, or the canvas's top right.
 * Not a live region: the shell's own hidden status region carries the announcement, so this can move. */
export function LiveNotices({ live, onKeepTheirs, onPutMineBack, onDismissNote }: Props) {
  if (!hasLiveNotices(live)) return null;
  const down = live.mode !== 'legacy' && live.reconnecting;
  const o = live.overwrite;
  return (
    <div className="live-notices">
      {o != null && (
        <div className="live-notice live-notice--ink" data-testid="live-overwrite">
          {o.parts.map((part) => (
            <Line key={`${part.head}\n${part.on}`} part={part} />
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
                  <span className="live-notice__mono">
                    {cap(item.field)}: {item.yours}
                  </span>
                  <button
                    type="button"
                    className="live-notice__btn"
                    aria-label={`Put my ${item.field} back`}
                    onClick={() => onPutMineBack(item.id)}
                  >
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
          {live.stuck && (
            <>
              {' '}
              <span data-testid="live-stuck">Still trying. {live.stuck}</span>
            </>
          )}
        </span>
      )}
    </div>
  );
}
