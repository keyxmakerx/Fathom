import { createContext, useContext, useEffect, useState } from 'react';

import { fetchTeams } from '../../api/teams';
import { fetchDesignWork, type DesignWork } from '../../api/work';
import type { Document } from '../../document/model';
import { addNote, notesOf } from '../../document/notes';
import { TYPED_AS_WRITTEN } from '../../document/plans';
import { numberWord, readWork, setWorkField, ticketHref, workFieldsOf, workKindOf, type WorkField } from '../../document/work';
import { initialsOfName } from './workModel';
import './work.css';

/** What an open design gives the Work tab's parts on its plans, issues and spares. */
export interface WorkPlace {
  organisationId: string;
  designId: string;
  accountId: string | null;
  doc: Document | null;
  canDraw: boolean;
  applyDocChange: (next: Document) => void;
  /** The redaction gate, for pasted text. */
  redact: (text: string) => Promise<string>;
}

export const WorkPlaceContext = createContext<WorkPlace | null>(null);

/** A design's numbers and who may be assigned there, asked once per open and again while the item
 * has no number yet (the server gives one a few seconds after the save that made it). */
function useDesignWork(place: WorkPlace | null, id: string): { work: DesignWork | null; error: string | null } {
  const [got, setGot] = useState<DesignWork | null>(null);
  const [error, setError] = useState<string | null>(null);
  const organisationId = place?.organisationId;
  const designId = place?.designId;
  useEffect(() => {
    if (organisationId == null || designId == null) return undefined;
    let cancelled = false;
    let tries = 0;
    let timer: number | undefined;
    const ask = () => {
      fetchDesignWork(organisationId, designId)
        .then((w) => {
          if (cancelled) return;
          setGot(w);
          setError(null);
          tries += 1;
          if (w.numbers[id] == null && tries < 4) timer = window.setTimeout(ask, 6000);
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(`Could not get the Fathom number and the people who can be assigned: ${messageOf(e)}`);
        });
    };
    ask();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [organisationId, designId, id]);
  return { work: got, error };
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const LABEL: Record<WorkField, string> = { assigned_to: 'Assigned to', due: 'Due', ticket: 'Outside ticket', team: 'Team' };

/** The teams this person can see, to name a plan's team from (schema 0.38). Empty until asked, or
 * when the list cannot be had: then `error` says why, so the row does not claim the team is one
 * this person cannot see. */
function useTeamNames(organisationId: string | undefined, wanted: boolean): { teams: { id: string; name: string }[]; error: string | null } {
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!wanted || organisationId == null) return undefined;
    let cancelled = false;
    fetchTeams(organisationId)
      .then((t) => {
        if (cancelled) return;
        setTeams(t.teams.map((x) => ({ id: x.id, name: x.name })));
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(`Could not get the list of teams: ${messageOf(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [organisationId, wanted]);
  return { teams, error };
}

/**
 * The Work tab's parts on one plan, issue or spare (sign-off r74): its Fathom number, who it is
 * assigned to, when an issue is due, the same work in Jira, ServiceNow or GLPI, and a short comment
 * thread. Everything is an ordinary edit of the design, one undo step each, live to everyone in it.
 */
export function WorkFields({ id }: { id: string }) {
  const place = useContext(WorkPlaceContext);
  const { work, error: workError } = useDesignWork(place, id);
  const { teams, error: teamsError } = useTeamNames(place?.organisationId, workKindOf(id) === 'MaintenancePlan');
  const [ticket, setTicket] = useState<{ value: string; pasted: boolean } | null>(null);
  const [comment, setComment] = useState<{ value: string; pasted: boolean }>({ value: '', pasted: false });
  const [error, setError] = useState<string | null>(null);
  const kind = workKindOf(id);
  const doc = place?.doc ?? null;
  const parts = doc ? readWork(doc, id) : null;
  if (place == null || doc == null || kind == null || parts == null) return null;
  const fields = workFieldsOf(kind);
  const canDraw = place.canDraw;
  const actor = place.accountId ?? undefined;

  const apply = (field: WorkField, value: string) => {
    try {
      place.applyDocChange(setWorkField(doc, id, field, value, { gate: TYPED_AS_WRITTEN, actor }));
      setError(null);
      return true;
    } catch (e) {
      setError(messageOf(e));
      return false;
    }
  };
  const saveTicket = async () => {
    if (ticket == null) return;
    let value: string;
    try {
      value = ticket.pasted ? await place.redact(ticket.value) : ticket.value;
    } catch (e) {
      // The gate could not run, so nothing pasted is saved; the typed text stays to try again.
      setError(`The ticket was not saved: ${messageOf(e)}`);
      return;
    }
    // A failed save keeps what was typed, beside the reason.
    if (value.trim() === parts.ticket || apply('ticket', value)) setTicket(null);
  };
  const addComment = async () => {
    const typed = comment.value.trim();
    if (typed === '') return;
    try {
      const text = comment.pasted ? (await place.redact(typed)).trim() : typed;
      place.applyDocChange(addNote(doc, id, { text, how: comment.pasted ? 'pasted' : 'typed', actor }));
      setComment({ value: '', pasted: false });
      setError(null);
    } catch (e) {
      setError(`The comment was not saved: ${messageOf(e)}`);
    }
  };

  const people = work?.people ?? {};
  const assignedName = parts.assignedTo ? (people[parts.assignedTo] ?? null) : null;
  const number = work?.numbers[id];
  // Until the lists arrive, or when they could not be had, an unknown id is not evidence that the
  // person left or the team is hidden.
  const unknownPerson = work == null ? (workError ? 'Someone Fathom could not look up' : '…') : 'Someone who can no longer work here';
  const unknownTeam = teamsError ? 'A team Fathom could not look up' : 'A team you cannot see';
  const comments = notesOf(doc, id);
  const href = ticketHref(parts.ticket);

  return (
    <section className="work-fields" aria-label="Work" data-testid="work-fields">
      <div className="work-fields__row">
        <span className="work-fields__label">Fathom number</span>
        <span className="work-fields__number">{number != null ? numberWord(number) : work == null ? (workError ? 'Not loaded' : '…') : 'given a few seconds after it is saved'}</span>
      </div>
      {fields.includes('assigned_to') && (
        <label className="work-fields__row">
          <span className="work-fields__label">{LABEL.assigned_to}</span>
          {canDraw ? (
            <select value={parts.assignedTo} onChange={(e) => apply('assigned_to', e.currentTarget.value)} aria-label={LABEL.assigned_to}>
              <option value="">Nobody yet</option>
              {parts.assignedTo !== '' && assignedName == null && <option value={parts.assignedTo}>{unknownPerson}</option>}
              {Object.entries(people)
                .sort((a, b) => a[1].localeCompare(b[1]))
                .map(([account, name]) => (
                  <option key={account} value={account}>
                    {account === place.accountId ? `${name} (you)` : name}
                  </option>
                ))}
            </select>
          ) : (
            <span>{parts.assignedTo === '' ? 'Nobody yet' : (assignedName ?? unknownPerson)}</span>
          )}
        </label>
      )}
      {fields.includes('team') && (
        <label className="work-fields__row">
          <span className="work-fields__label">{LABEL.team}</span>
          {canDraw ? (
            <select value={parts.team} onChange={(e) => apply('team', e.currentTarget.value)} aria-label={LABEL.team} data-testid="work-team">
              <option value="">No team</option>
              {parts.team !== '' && !teams.some((t) => t.id === parts.team) && <option value={parts.team}>{unknownTeam}</option>}
              {[...teams]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
          ) : (
            <span>{parts.team === '' ? 'No team' : (teams.find((t) => t.id === parts.team)?.name ?? unknownTeam)}</span>
          )}
        </label>
      )}
      {fields.includes('due') && (
        <label className="work-fields__row">
          <span className="work-fields__label">{LABEL.due}</span>
          {canDraw ? (
            <input type="date" value={parts.due} onChange={(e) => apply('due', e.currentTarget.value)} aria-label={LABEL.due} />
          ) : (
            <span>{parts.due || 'Not set'}</span>
          )}
        </label>
      )}
      <label className="work-fields__row">
        <span className="work-fields__label">{LABEL.ticket}</span>
        {canDraw ? (
          <span className="work-fields__ticket">
            <input
              type="text"
              placeholder="A Jira, ServiceNow or GLPI link, or its number"
              value={ticket?.value ?? parts.ticket}
              onChange={(e) => setTicket({ value: e.currentTarget.value, pasted: ticket?.pasted ?? false })}
              onPaste={() => setTicket((t) => ({ value: t?.value ?? parts.ticket, pasted: true }))}
              onBlur={() => void saveTicket()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveTicket();
                if (e.key === 'Escape') setTicket(null);
              }}
              aria-label={LABEL.ticket}
            />
            {href && ticket == null && (
              <a href={href} target="_blank" rel="noopener noreferrer">
                Open
              </a>
            )}
          </span>
        ) : href ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {parts.ticket}
          </a>
        ) : (
          <span>{parts.ticket || 'None'}</span>
        )}
      </label>
      <div className="work-fields__comments">
        <span className="work-fields__label">Comments</span>
        {comments.length === 0 ? (
          <p className="work__muted">No comments yet.</p>
        ) : (
          <ul className="work-fields__thread">
            {comments.map((c) => {
              const who = people[c.who] ?? (c.who === place.accountId ? 'You' : 'Someone');
              return (
                <li key={c.id}>
                  <span className="work__av" title={who}>
                    {initialsOfName(who)}
                  </span>
                  <span>
                    <span className="work__muted">
                      {who} · {c.when > 0 ? new Date(c.when).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : ''}
                    </span>
                    <span className="work-fields__text">{c.text}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {canDraw && (
          <div className="work-fields__add">
            <textarea
              rows={2}
              value={comment.value}
              placeholder="Add a comment"
              aria-label="Add a comment"
              onChange={(e) => setComment({ value: e.currentTarget.value, pasted: comment.pasted })}
              onPaste={() => setComment((c) => ({ ...c, pasted: true }))}
            />
            <button type="button" className="btn-small" disabled={comment.value.trim() === ''} onClick={() => void addComment()}>
              Comment
            </button>
          </div>
        )}
      </div>
      {[error, workError, teamsError].map(
        (e) =>
          e && (
            <p key={e} className="work-fields__error" role="alert">
              {e}
            </p>
          ),
      )}
    </section>
  );
}
