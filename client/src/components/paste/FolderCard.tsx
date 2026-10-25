// A folder of configs dropped on the canvas (round 29, card r29-pull A): one row per file, after the gate and before
// anything is stored. A first config for a drawn device and a device not drawn yet are ticked; a device that already
// carries a config is only compared; anything else says why it was left. "Add" is the only write.
import { useEffect, useId, useRef, useState, type JSX } from 'react';

import { changed, type FolderChanges, type FolderRow } from './configFolder';
import './paste.css';
import '../suggest/suggest.css';

export interface FolderCardProps {
  rows: readonly FolderRow[];
  /** The rows to write, in the card's order. */
  onAdd: (rows: FolderRow[]) => void;
  onClose: () => void;
  refusal?: string;
}

export const FOLDER_LINE = 'Each file went through the gate on this page. Tick what to keep; nothing changes until you add it.';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const names = (list: string[]): string => (list.length > 3 ? `${list.slice(0, 3).join(', ')} and ${list.length - 3} more` : list.join(', '));

/** What changed since the drawing's copy, in words. */
export function changeWords(c: FolderChanges): string {
  if (!changed(c)) return 'Nothing changed since the copy in the drawing.';
  const said: string[] = [];
  if (c.added.length > 0) said.push(`${plural(c.added.length, 'new interface')} (${names(c.added)})`);
  if (c.gone.length > 0) said.push(`${plural(c.gone.length, 'interface')} gone (${names(c.gone)})`);
  if (c.readdressed.length > 0) said.push(`new addresses on ${names(c.readdressed)}`);
  if (c.version !== null) said.push(c.version.was === null ? `running ${c.version.now}` : `version ${c.version.was} to ${c.version.now}`);
  return `Changed since the copy in the drawing: ${said.join('; ')}. It already carries a config, so this one is not added yet.`;
}

export function FolderCard({ rows, onAdd, onClose, refusal }: FolderCardProps): JSX.Element {
  const writable = rows.filter((r) => r.outcome === 'attach' || r.outcome === 'add');
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(writable.map((r) => r.file)));
  const ref = useRef<HTMLDivElement>(null);
  const headId = useId();

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, button')?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const compared = rows.filter((r) => r.outcome === 'compare');
  const left = rows.filter((r) => r.outcome === 'skip');
  const chosen = writable.filter((r) => ticked.has(r.file));
  const destroyed = rows.reduce((n, r) => n + r.destroyed, 0);

  return (
    <div className="paste-card suggest-card" role="dialog" aria-labelledby={headId} data-testid="folder-card" ref={ref}>
      <div className="paste-card__head" id={headId}>
        Configs from a folder
      </div>
      <p className="suggest-card__line">{FOLDER_LINE}</p>

      {writable.length > 0 && (
        <ul className="suggest-card__rows">
          {writable.map((r) => (
            <li key={r.file}>
              <label>
                <input
                  type="checkbox"
                  checked={ticked.has(r.file)}
                  onChange={(e) => {
                    const next = new Set(ticked);
                    if (e.target.checked) next.add(r.file);
                    else next.delete(r.file);
                    setTicked(next);
                  }}
                />
                <span className="suggest-card__end">{r.hostname}</span>
                <span className="suggest-card__end suggest-card__far suggest-card__left">{r.outcome === 'attach' ? 'its first config' : 'a new device'}</span>
              </label>
              {r.why !== null && <p className="paste-card__note suggest-card__why">{r.why}</p>}
            </li>
          ))}
        </ul>
      )}

      {compared.map((r) => (
        <p key={r.file} className="paste-card__note suggest-card__why" data-testid="folder-compare">
          <strong>{r.hostname}</strong>: {r.changes !== null ? changeWords(r.changes) : ''}
        </p>
      ))}
      {left.map((r) => (
        <p key={r.file} className="paste-card__note suggest-card__why">
          <span className="suggest-card__port">{r.file}</span>: {r.why}
        </p>
      ))}
      {destroyed > 0 && <p className="paste-card__gate">The gate destroyed {plural(destroyed, 'value')} across these files before anything was stored.</p>}
      {rows.length === 0 && <p className="paste-card__note">There was nothing in it to read.</p>}
      {refusal !== undefined && refusal !== '' && <p className="paste-card__refusal" role="alert">{refusal}</p>}

      <div className="paste-card__actions suggest-card__actions">
        <button type="button" onClick={onClose}>
          {writable.length > 0 ? 'Skip' : 'Close'}
        </button>
        {writable.length > 0 && (
          <button type="button" className="suggest-card__add" disabled={chosen.length === 0} onClick={() => onAdd(chosen)}>
            Add {chosen.length}
          </button>
        )}
      </div>
    </div>
  );
}
