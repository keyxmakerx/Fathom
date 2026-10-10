import { useState } from 'react';

import type { History } from './useHistory';
import './history.css';
import { SkeletonRows } from '../ui/Skeleton';

/** "Today 14:02", "Yesterday 09:12", "2 Oct 09:12". */
export function whenLabel(atUnix: number, now: Date = new Date()): string {
  const at = new Date(atUnix * 1000);
  const hm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return `Today ${hm}`;
  if (days === 1) return `Yesterday ${hm}`;
  const month = at.toLocaleString('en-GB', { month: 'short' });
  return `${at.getDate()} ${month} ${hm}`;
}

export interface HistoryPanelProps {
  history: History;
  accountId: string | null;
  accountAddress: string | null;
  canDraw: boolean;
  /** The Restore confirm's sentence for the picked version. */
  restoreText: string;
  onRestore: () => void;
  onClose: () => void;
}

export function HistoryPanel({ history, accountId, accountAddress, canDraw, restoreText, onRestore, onClose }: HistoryPanelProps) {
  const [confirming, setConfirming] = useState(false);
  const { saves, picked } = history;
  const latest = saves?.[0]?.designVersion;

  return (
    <div className="history" aria-label="History" data-testid="history-panel">
      <div className="history__head">
        <span className="history__title">History</span>
        <button type="button" className="history__close" onClick={onClose} aria-label="Close history">
          Close
        </button>
      </div>
      <p className="history__verify" data-testid="history-verify">
        {history.verifyLine.startsWith('Checked') ? '\u2713 ' : ''}
        {history.verifyLine}
      </p>
      {history.error != null && <p className="history__note">{history.error}</p>}
      {saves == null && history.error == null && <SkeletonRows label="Loading the saves…" rows={6} />}
      <ol className="history__list">
        {saves?.slice(0, history.shown).map((s) => {
          const on = picked?.version === s.designVersion;
          return (
            <li key={s.designVersion}>
              <button
                type="button"
                className={`history__row${on ? ' history__row--on' : ''}`}
                aria-pressed={on}
                onClick={() => {
                  setConfirming(false);
                  void history.pickVersion(s.designVersion);
                }}
              >
                <span className="history__when">
                  <b>{whenLabel(s.atUnix)}</b> · {s.actor == null ? 'unknown' : s.actor === accountId ? (accountAddress ?? 'you') : 'a colleague'}
                </span>
                <span className="history__what">{history.summaries.get(s.designVersion) ?? '…'}</span>
              </button>
            </li>
          );
        })}
      </ol>
      {saves != null && history.shown < saves.length && (
        <button type="button" className="history__older" onClick={history.showOlder}>
          Show older saves
        </button>
      )}
      {picked != null && (
        <div className="history__actions">
          <button
            type="button"
            className="history__btn"
            onClick={() => {
              setConfirming(false);
              history.back();
            }}
          >
            Back to now
          </button>
          {canDraw && picked.version !== latest && !confirming && (
            <button type="button" className="history__btn history__btn--primary" onClick={() => setConfirming(true)}>
              Restore this version
            </button>
          )}
          {confirming && (
            <div className="history__confirm" role="alertdialog" aria-label="Restore this version">
              <p>
                {restoreText} It is saved as a new version; both stay in this list.
              </p>
              <button
                type="button"
                className="history__btn history__btn--primary"
                onClick={() => {
                  setConfirming(false);
                  onRestore();
                }}
              >
                Restore
              </button>
              <button type="button" className="history__btn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
