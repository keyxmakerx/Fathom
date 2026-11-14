import type { ReactNode } from 'react';

import './feedback.css';

/** The words every unfinished part carries. One string, so a tester sees one mark everywhere. */
export const NOT_FINISHED = 'Not finished';

/** The small mark beside a name: a hairline box, spaced capitals, ink and no colour (alpha, 2026-11-12). */
export function NotFinishedMark({ className }: { className?: string }) {
  return (
    <span className={`not-finished${className ? ` ${className}` : ''}`} data-testid="not-finished">
      {NOT_FINISHED}
    </span>
  );
}

export interface NotFinishedPageProps {
  title: string;
  /** What is already there, in plain words. */
  works: readonly string[];
  /** What a tester will not find yet. */
  missing: readonly string[];
  children?: ReactNode;
}

/** A page for a part with server work and no screen yet: says so first, then what exists and what does not. */
export function NotFinishedPage({ title, works, missing, children }: NotFinishedPageProps) {
  return (
    <section className="org-page not-finished-page" data-testid="not-finished-page">
      <div className="org-page__title">
        {title} <NotFinishedMark />
      </div>
      <p className="not-finished-page__lead">
        This part of Fathom is not finished. Nothing on this page can be changed yet, and nothing here is lost: what you do elsewhere is
        not affected.
      </p>
      <div className="not-finished-page__cols">
        <div>
          <div className="not-finished-page__head">What is there</div>
          <ul>
            {works.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
        <div>
          <div className="not-finished-page__head">What is not there yet</div>
          <ul>
            {missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      </div>
      {children}
    </section>
  );
}
