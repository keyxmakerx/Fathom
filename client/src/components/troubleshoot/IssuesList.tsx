// Issues as an Inventory kind (ADR-0061 troubleshooting): the saved "It's down" sessions, newest first, and an
// Issue page for one (mockup r8-trouble-b): the checks as a list, the notes, and "Show on canvas". Read only.
import { useState } from 'react';

import type { Document } from '../../document/model';
import { listIssues, type Issue } from '../../document/issues';
import { nameOf } from '../plans/plansModel';
import { ANSWER_WORD, whenText } from './troubleModel';
import './trouble.css';

export function IssuePage({ issue, onBack, onShowOnCanvas }: { issue: Issue; onBack(): void; onShowOnCanvas?: (id: string) => void }) {
  const notes = issue.steps.filter((s) => s.note !== '');
  return (
    <article className="issue-page" data-testid="issue-page" aria-label={issue.title}>
      <header className="issue-page__head">
        <h2 className="issue-page__title">{issue.title}</h2>
        {onShowOnCanvas != null && (
          <button type="button" className="trouble-btn" onClick={() => onShowOnCanvas(issue.id)} data-testid="issue-show-on-canvas">
            Show on canvas
          </button>
        )}
      </header>
      <p className="issue-page__line">
        Opened {whenText(issue.openedAt)}
        {issue.author !== '' ? ` · ${issue.author}` : ''} · {issue.stage}
      </p>
      <table className="issue-page__table">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Check</th>
            <th scope="col">Answer</th>
          </tr>
        </thead>
        <tbody>
          {issue.steps.map((s) => (
            <tr key={s.id} data-answer={s.answer}>
              <td>{s.ordinal + 1}</td>
              <td>
                {s.question}
                {s.detail !== '' && <span className="issue-page__detail">{s.detail}</span>}
              </td>
              <td>{ANSWER_WORD[s.answer]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <section className="issue-page__notes" aria-label="Notes">
        <h3 className="trouble-label">Notes</h3>
        {issue.outcome !== '' && <p className="issue-page__outcome">{issue.outcome}</p>}
        {notes.map((s) => (
          <p key={s.id}>
            {s.ordinal + 1} · {s.note}
          </p>
        ))}
        {issue.outcome === '' && notes.length === 0 && <p className="inventory-place__muted">No notes.</p>}
      </section>
      <button type="button" className="trouble-link" onClick={onBack}>
        Back to the issues
      </button>
    </article>
  );
}

export function IssuesList({ doc, onShowOnCanvas }: { doc: Document; onShowOnCanvas?: (issueId: string) => void }) {
  const issues = listIssues(doc);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = openId == null ? undefined : issues.find((i) => i.id === openId);
  if (open != null) return <IssuePage issue={open} onBack={() => setOpenId(null)} onShowOnCanvas={onShowOnCanvas} />;
  return (
    <table className="inventory-place__grid" data-testid="issues-list">
      <thead>
        <tr>
          <th aria-hidden="true" />
          <th>Issue</th>
          <th>Device</th>
          <th>Opened</th>
          <th>State</th>
          <th>Where the answers pointed</th>
        </tr>
      </thead>
      <tbody>
        {issues.length === 0 ? (
          <tr>
            <td colSpan={6} className="inventory-place__muted">
              No issues yet. Right-click a device on the canvas and choose It's down.
            </td>
          </tr>
        ) : (
          issues.map((i) => (
            <tr
              key={i.id}
              className="inventory-place__row issue-row"
              tabIndex={0}
              aria-label={`Open ${i.title}`}
              onClick={() => setOpenId(i.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setOpenId(i.id);
                }
              }}
            >
              <td aria-hidden="true" />
              <td>{i.title}</td>
              <td>{nameOf(doc, (id) => id, i.deviceId)}</td>
              <td>{whenText(i.openedAt)}</td>
              <td>{i.stage}</td>
              <td>{i.outcome.split('\n')[0]}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
