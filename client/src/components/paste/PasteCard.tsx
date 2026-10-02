// ADR-0061 §7: the card a pasted config opens, after the gate and before
// anything is stored. It shows what was read, what the gate destroyed (counts
// by kind, never values) and the one choice: attach to the same-named device,
// or add a new one. Cancelling stores nothing.
import { useEffect, useRef, useState, type JSX } from 'react';

import type { PastePreview } from './pasteConfig';
import './paste.css';

export type PasteState =
  | { kind: 'ask' }
  | { kind: 'reading' }
  | { kind: 'card'; preview: PastePreview }
  | { kind: 'refused'; message: string };

export interface PasteCardProps {
  state: PasteState;
  /** The text typed or pasted into the card's own box, when the clipboard could not be read for it. */
  onText: (text: string) => void;
  onChoose: (choice: 'attach' | 'add') => void;
  onCancel: () => void;
}

const SHOWN = 10;

export function PasteCard({ state, onText, onChoose, onCancel }: PasteCardProps): JSX.Element {
  const [text, setText] = useState('');
  const preview = state.kind === 'card' ? state.preview : null;
  const canAttach = preview?.attachDoc != null;
  const [choice, setChoice] = useState<'attach' | 'add'>(canAttach ? 'attach' : 'add');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setChoice(canAttach ? 'attach' : 'add'), [canAttach]);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('textarea, button')?.focus();
  }, [state.kind]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const total = preview?.destroyed.reduce((n, d) => n + d.count, 0) ?? 0;

  return (
    <div className="paste-card" role="dialog" aria-label="Paste a config" ref={ref} data-testid="paste-card">
      <div className="paste-card__head">Paste a config</div>

      {state.kind === 'ask' && (
        <>
          <p className="paste-card__note">Paste the config here. It goes through the gate on this page before anything is stored.</p>
          <textarea className="paste-card__box" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="paste a config" />
          <div className="paste-card__actions">
            <button type="button" onClick={() => text.trim() !== '' && onText(text)} disabled={text.trim() === ''}>
              Read it
            </button>
            <button type="button" onClick={onCancel}>Cancel</button>
          </div>
        </>
      )}

      {state.kind === 'reading' && <p className="paste-card__note">Reading it through the gate…</p>}

      {state.kind === 'refused' && (
        <>
          <p className="paste-card__refusal">{state.message}</p>
          <div className="paste-card__actions">
            <button type="button" onClick={onCancel}>Close</button>
          </div>
        </>
      )}

      {preview && (
        <>
          <dl className="paste-card__read">
            <dt>Hostname</dt>
            <dd>{preview.hostname || 'not named in the config'}</dd>
            <dt>Platform</dt>
            <dd>{[preview.platform, preview.osVersion].filter(Boolean).join(' ') || 'unknown'}</dd>
            <dt>Interfaces</dt>
            <dd>
              {preview.interfaces.length === 0 ? (
                'none found'
              ) : (
                <ul className="paste-card__ifaces">
                  {preview.interfaces.slice(0, SHOWN).map((i) => (
                    <li key={i.name}>
                      <span>{i.name}</span> {i.addresses.join(', ')}
                    </li>
                  ))}
                  {preview.interfaces.length > SHOWN && <li>and {preview.interfaces.length - SHOWN} more</li>}
                </ul>
              )}
            </dd>
          </dl>

          <p className="paste-card__gate" data-testid="paste-destroyed">
            {total === 0
              ? 'The gate found no credentials to destroy.'
              : `The gate destroyed ${total} ${total === 1 ? 'value' : 'values'} before anything was stored: ${preview.destroyed.map((d) => `${d.label} ×${d.count}`).join(', ')}.`}
          </p>

          <fieldset className="paste-card__choice">
            {preview.match !== null && (
              <label className={canAttach ? '' : 'paste-card__off'}>
                <input type="radio" name="paste-choice" checked={choice === 'attach'} disabled={!canAttach} onChange={() => setChoice('attach')} />
                Attach to {preview.match.hostname}
                {preview.match.hasCapture && ' (it already carries a config; a second is not accepted yet)'}
              </label>
            )}
            <label>
              <input type="radio" name="paste-choice" checked={choice === 'add'} onChange={() => setChoice('add')} />
              Add as a new device
            </label>
          </fieldset>

          <div className="paste-card__actions">
            <button type="button" onClick={() => onChoose(choice)}>{choice === 'attach' ? 'Attach' : 'Add'}</button>
            <button type="button" onClick={onCancel}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}
