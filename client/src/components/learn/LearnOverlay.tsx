// The Learn library and one explainer, over the page like Docs (ADR-0066 item 1.1). Every entry
// that nobody has vouched for says Unreviewed at the top, with the date it was written and its
// sources (OPEN-QUESTIONS E2).

import { useRef, type ReactNode } from 'react';

import type { Explainer } from '../../api/learn';
import { safeUrl } from '../../document/docs';
import { useLearn } from './context';
import { FIRST_TAB, library, titleOf } from './explainers';
import './learn.css';
import { useModal } from '../shell/useModal';

export type LearnView = { kind: 'library' } | { kind: 'entry'; id: string; from: 'library' | 'direct' };

/** Backticks are code; a line break in the corpus text starts a new paragraph. */
export function Prose({ text }: { text: string }) {
  const paras = text.split(/\n+/).map((p) => p.trim()).filter((p) => p !== '');
  return (
    <>
      {paras.map((p, i) => (
        <p key={i}>{inline(p)}</p>
      ))}
    </>
  );
}

function inline(p: string): ReactNode[] {
  return p.split(/(`[^`]+`)/).map((part, i) => (part.startsWith('`') && part.endsWith('`') && part.length > 2 ? <code key={i}>{part.slice(1, -1)}</code> : part));
}

export function UnreviewedMark({ e }: { e: Explainer }) {
  if (e.reviewed) return null;
  return (
    <span className="learn-unreviewed" title="Nobody has checked this against the sources yet.">
      Unreviewed
    </span>
  );
}

function Sources({ e }: { e: Explainer }) {
  if (e.sources.length === 0) return null;
  return (
    <section className="learn-entry__sources">
      <h3>Sources</h3>
      <ul>
        {e.sources.map((s, i) => {
          const url = s.url ? safeUrl(s.url) : null;
          return (
            <li key={i}>
              {url ? (
                <a href={url.href} target="_blank" rel="noreferrer noopener">
                  {s.doc}
                </a>
              ) : (
                s.doc
              )}
              {s.publisher ? <span className="learn-muted"> · {s.publisher}</span> : null}
              {s.readOn ? <span className="learn-muted"> · read {s.readOn}</span> : null}
              {s.note ? <div className="learn-muted learn-small">{s.note}</div> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function ExplainerPage({ e }: { e: Explainer }) {
  return (
    <article className="learn-entry" data-testid="explainer-page">
      <h2>
        {titleOf(e)} <UnreviewedMark e={e} />
      </h2>
      {e.terse ? (
        <div className="learn-entry__lead">
          <Prose text={e.terse} />
        </div>
      ) : null}
      {e.explained ? <Prose text={e.explained} /> : null}
      {e.teaching ? (
        <section>
          <h3>In practice</h3>
          <Prose text={e.teaching} />
        </section>
      ) : null}
      {e.breaksIfWrong ? (
        <section>
          <h3>What goes wrong if you get it wrong</h3>
          <Prose text={e.breaksIfWrong} />
        </section>
      ) : null}
      <Sources e={e} />
      {e.reviewedOn ? <p className="learn-muted learn-small">Written {e.reviewedOn}.</p> : null}
    </article>
  );
}

function Library({ all, onOpen }: { all: readonly Explainer[]; onOpen: (id: string) => void }) {
  return (
    <div className="learn-library" data-testid="learn-library">
      {library(all).map((g) => (
        <section key={g.topic}>
          <h3>{g.topic}</h3>
          <ul>
            {g.entries.map((e) => (
              <li key={e.id}>
                <button type="button" className="learn-link" onClick={() => onOpen(e.id)}>
                  {titleOf(e)}
                </button>
                {e.tab === FIRST_TAB ? <span className="learn-tag">Start here</span> : null}
                <UnreviewedMark e={e} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function LearnOverlay({ view, onView, onClose }: { view: LearnView; onView: (v: LearnView) => void; onClose: () => void }) {
  const api = useLearn();
  const ref = useRef<HTMLDivElement>(null);
  useModal(ref, onClose, { focus: 'container' });
  if (!api) return null;
  const entry = view.kind === 'entry' ? (api.explainers.find((e) => e.id === view.id) ?? null) : null;
  return (
    <div className="learn-overlay" role="dialog" aria-modal="true" aria-label="Learn" tabIndex={-1} ref={ref}>
      <div className="learn-overlay__head">
        {view.kind === 'entry' ? (
          <button type="button" className="learn-link" onClick={() => onView({ kind: 'library' })}>
            ← All explainers
          </button>
        ) : (
          <span>Learn</span>
        )}
        <button type="button" className="learn-overlay__close" aria-label="Close Learn" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="learn-overlay__body">
        {api.status === 'loading' ? <p className="learn-muted">Loading…</p> : null}
        {api.status === 'error' ? <p>The explainers could not be loaded. Try again in a moment.</p> : null}
        {api.status === 'ready' && view.kind === 'library' ? <Library all={api.explainers} onOpen={(id) => onView({ kind: 'entry', id, from: 'library' })} /> : null}
        {api.status === 'ready' && view.kind === 'entry' ? entry ? <ExplainerPage e={entry} /> : <p>That explainer is not in this version of Fathom.</p> : null}
      </div>
    </div>
  );
}
