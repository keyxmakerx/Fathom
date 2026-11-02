import { useCallback, useEffect, useRef, useState } from 'react';

import { openElsewhere } from '../../api/estate';
import { fetchWork, type WorkAnswer, type WorkRow } from '../../api/work';
import { ticketHref } from '../../document/work';
import { coverageSentence } from '../inventory/EverywherePanel';
import {
  KIND_FILTERS,
  KIND_WORD,
  isLate,
  numberOf,
  sections,
  sitesOf,
  stateLine,
  todayIso,
  whereOf,
  whoOf,
  type Filters,
  type KindFilter,
} from './workModel';
import './work.css';

/** How often the list asks again while it is in view: "rows change as the work moves" (r74). */
export const WORK_REFRESH_MS = 5000;

type Loaded = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; answer: WorkAnswer };

/**
 * The Work tab (sign-off r74): every maintenance plan, It's down issue and spare on order, away or
 * lent, in every design this person may open, as one list. Each row opens the real thing in its
 * design, so nothing here is a second copy. Rows change as the work moves: the list asks the server
 * again every few seconds while it is in view, and says who is in each design now. On a phone the
 * rows are cards and the filters one menu.
 */
export function WorkPage({ organisationId, currentDesign = null }: { organisationId: string; currentDesign?: string | null }) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [done, setDone] = useState<{ open: boolean; answer: WorkAnswer | null; error: string | null }>({ open: false, answer: null, error: null });
  const [filters, setFilters] = useState<Filters>({ kind: 'all', mine: false, design: '' });
  const busy = useRef(false);

  const load = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    fetchWork(organisationId)
      .then((answer) => setLoaded({ status: 'ready', answer }))
      .catch((e: unknown) =>
        // A list already shown stays shown when one refresh fails; the next one tries again.
        setLoaded((was) => (was.status === 'ready' ? was : { status: 'error', message: e instanceof Error ? e.message : String(e) })),
      )
      .finally(() => {
        busy.current = false;
      });
  }, [organisationId]);

  useEffect(() => {
    setLoaded({ status: 'loading' });
    setDone({ open: false, answer: null, error: null });
    load();
    const tick = window.setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, WORK_REFRESH_MS);
    const onShow = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onShow);
    return () => {
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [load]);

  const showDone = () => {
    setDone({ open: true, answer: null, error: null });
    fetchWork(organisationId, true)
      .then((answer) => setDone({ open: true, answer, error: null }))
      .catch((e: unknown) => setDone({ open: true, answer: null, error: e instanceof Error ? e.message : String(e) }));
  };

  if (loaded.status === 'loading') return <p className="work__muted">Gathering the work…</p>;
  if (loaded.status === 'error') return <p className="work__muted">Could not gather the work: {loaded.message}</p>;
  const { answer } = loaded;
  const { now, coming, counts } = sections(answer.rows, filters, answer.you);
  const sites = sitesOf(answer.rows);
  const today = todayIso();
  const doneRows = done.answer ? sections(done.answer.rows, { ...filters }, done.answer.you) : null;

  return (
    <div className="work" data-testid="work-page">
      <div className="work__bar">
        <div className="work__kinds" role="group" aria-label="Kind of work">
          {KIND_FILTERS.map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={filters.kind === k ? 'work__chip work__chip--on' : 'work__chip'}
              aria-pressed={filters.kind === k}
              onClick={() => setFilters({ ...filters, kind: k })}
            >
              {label} <span className="work__count">{counts[k]}</span>
            </button>
          ))}
        </div>
        {/* On a phone the chips fold into this one menu. */}
        <select className="work__kinds-menu" aria-label="Kind of work" value={filters.kind} onChange={(e) => setFilters({ ...filters, kind: e.currentTarget.value as KindFilter })}>
          {KIND_FILTERS.map(([k, label]) => (
            <option key={k} value={k}>
              {label} ({counts[k]})
            </option>
          ))}
        </select>
        <select aria-label="Site" value={filters.design} onChange={(e) => setFilters({ ...filters, design: e.currentTarget.value })}>
          <option value="">Every site</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <label className="work__mine">
          <input type="checkbox" checked={filters.mine} onChange={(e) => setFilters({ ...filters, mine: e.currentTarget.checked })} /> Mine
        </label>
      </div>

      <WorkSection title="Now" note="updates live" rows={now} answer={answer} today={today} currentDesign={currentDesign} empty="Nothing under way." />
      <WorkSection title="Coming up and waiting" rows={coming} answer={answer} today={today} currentDesign={currentDesign} empty="Nothing planned or waiting." />

      {!done.open ? (
        <button type="button" className="btn-quiet" onClick={showDone}>
          Show finished work
        </button>
      ) : done.error ? (
        <p className="work__muted">Could not gather the finished work: {done.error}</p>
      ) : doneRows == null || done.answer == null ? (
        <p className="work__muted">Gathering the finished work…</p>
      ) : (
        <WorkSection title="Finished" rows={[...doneRows.now, ...doneRows.coming]} answer={done.answer} today={today} currentDesign={currentDesign} empty="Nothing finished yet." />
      )}

      <p className="work__muted">{coverageSentence(answer)}</p>
    </div>
  );
}

function WorkSection({
  title,
  note,
  rows,
  answer,
  today,
  currentDesign,
  empty,
}: {
  title: string;
  note?: string;
  rows: readonly WorkRow[];
  answer: WorkAnswer;
  today: string;
  currentDesign: string | null;
  empty: string;
}) {
  return (
    <section className="work__section" aria-label={title}>
      <h3 className="work__label">
        {title}
        {note ? <span className="work__note"> · {note}</span> : null}
      </h3>
      {rows.length === 0 ? (
        <p className="work__muted">{empty}</p>
      ) : (
        <ul className="work__rows">
          <li className="work__head" aria-hidden="true">
            <span>No.</span>
            <span>Kind</span>
            <span>What</span>
            <span>Where</span>
            <span>State</span>
            <span>Who</span>
          </li>
          {rows.map((r) => (
            <WorkItem key={`${r.design}:${r.element}`} row={r} answer={answer} late={isLate(r, today)} currentDesign={currentDesign} />
          ))}
        </ul>
      )}
    </section>
  );
}

function WorkItem({ row, answer, late, currentDesign }: { row: WorkRow; answer: WorkAnswer; late: boolean; currentDesign: string | null }) {
  const who = whoOf(row, answer);
  const href = ticketHref(row.ticket);
  return (
    <li className={late ? 'work__row work__row--late' : 'work__row'} data-testid="work-row">
      <span className="work__number">{numberOf(row)}</span>
      <span className="work__kind">{KIND_WORD[row.kind]}</span>
      <span className="work__what">
        <button type="button" className="btn-link" onClick={() => openElsewhere(row.design, row.open)}>
          {row.title}
        </button>
        {row.ticket ? (
          <span className="work__ticket">
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {row.ticket.length > 40 ? 'Outside ticket' : row.ticket}
              </a>
            ) : (
              row.ticket
            )}
          </span>
        ) : null}
        {row.comments > 0 ? <span className="work__comments">{row.comments === 1 ? '1 comment' : `${row.comments} comments`}</span> : null}
      </span>
      <span className="work__where">{whereOf(row, currentDesign)}</span>
      <span className="work__state">
        {stateLine(row)}
        {late ? <span className="work__late"> · late</span> : null}
      </span>
      <span className="work__who">
        {who.assigned ? (
          <span className="work__av" title={who.assigned.name}>
            {who.assigned.initials}
          </span>
        ) : who.gone ? (
          <span className="work__muted">someone no longer here</span>
        ) : (
          <span className="work__muted">nobody yet</span>
        )}
        {who.inIt.length > 0 ? (
          <span className="work__in" title={who.inIt.map((p) => p.name).join(', ')}>
            in it now: {who.inIt.map((p) => p.initials).join(' ')}
          </span>
        ) : null}
      </span>
    </li>
  );
}
