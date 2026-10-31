import { useState } from 'react';

import type { Document } from '../../document/model';
import type { History } from './useHistory';
import './history.css';
import { SkeletonRows } from '../ui/Skeleton';
import { ThingName } from '../shell/ThingName';
import { whoWord } from '../collab/changesSince';

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
  /** A thing's name in the picked save, for its "Changed" line; null for one with no name to show. */
  nameOf?: (id: string, doc: Document) => string | null;
  /** The design, so a save names a colleague this design has heard (rua-ui-audit). */
  designId?: string;
}

/** The most names the Changed line lists before "and N more". */
const CHANGED_SHOWN = 8;

export function HistoryPanel({ history, accountId, accountAddress, canDraw, restoreText, onRestore, onClose, nameOf, designId }: HistoryPanelProps) {
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
                  <b>{whenLabel(s.atUnix)}</b> · {s.viaAi != null && <span className="history__ai">AI ({s.viaAi}), for </span>}
                  {whoWord(s.actor, accountId, designId, accountAddress ?? 'you')}
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
      {picked != null && nameOf != null ? <ChangedNames ids={picked.change.changed} nameOf={(id) => nameOf(id, picked.doc)} /> : null}
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
              <button type="button" className="history__btn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
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
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Sign-off r60: what the picked save changed, each name a link to it on the canvas. */
function ChangedNames({ ids, nameOf }: { ids: readonly string[]; nameOf: (id: string) => string | null }) {
  // A device and its chassis share a name: one link for both.
  const byName = new Map<string, string[]>();
  for (const id of new Set(ids)) {
    const name = nameOf(id);
    if (name != null && name !== '') byName.set(name, [...(byName.get(name) ?? []), id]);
  }
  // Ports ("fw-01 · 3") after the devices, racks and cables, so a save that added one device leads with it.
  const named = [...byName].map(([name, of]) => ({ name, ids: of })).sort((a, b) => Number(a.name.includes(' · ')) - Number(b.name.includes(' · ')));
  if (named.length === 0) return null;
  const shown = named.slice(0, CHANGED_SHOWN);
  return (
    <p className="history__changed" data-testid="history-changed">
      Changed:{' '}
      {shown.map((t, i) => (
        <span key={t.name}>
          {i > 0 ? ', ' : ''}
          <ThingName ids={t.ids}>{t.name}</ThingName>
        </span>
      ))}
      {named.length > shown.length ? ` and ${named.length - shown.length} more` : ''}
    </p>
  );
}
