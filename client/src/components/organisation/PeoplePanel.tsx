import { useState } from 'react';

import type { Asked } from '../../api/invitations';
import type { AccessRow, People, Person } from '../../api/people';
import type { Scope } from '../../api/scopes';
import { accessWords, canDoWords, CAPABILITY_WORD, dateLabel, removalWords, stateMark, stateWords, whyNotRemovable } from './model';

export interface PeopleListProps {
  people: People;
  /** Joined people and steward requests waiting on this steward. */
  needsYou: { joined: { name: string; asked: string }[]; seconding: { granter: string | null; subject: string; where: string }[] };
  onOpenPerson: (account: string) => void;
  onInvite: () => void;
  onOpenWaiting: () => void;
}

/** Everyone, what they can do where, and whether they are in yet. */
export function PeopleList({ people, needsYou, onOpenPerson, onInvite, onOpenWaiting }: PeopleListProps) {
  const waitingLines = needsYou.joined.length + needsYou.seconding.length;
  return (
    <section className="org-page">
      <div className="home__section-head">
        <div className="org-page__title">People</div>
        <button type="button" className="org-btn org-btn--primary" onClick={onInvite}>
          Invite someone
        </button>
      </div>

      {waitingLines > 0 && (
        <div className="org-box" data-testid="people-waiting-box">
          <div className="home__label">Waiting for you</div>
          <ul className="org-box__list">
            {needsYou.joined.slice(0, 3).map((j, i) => (
              <li key={`j${i}`}>
                <strong>{j.name}</strong> joined. Asked for {j.asked}.
              </li>
            ))}
            {needsYou.seconding.slice(0, 2).map((s, i) => (
              <li key={`s${i}`}>
                {s.granter ?? 'A steward'} asked to make <strong>{s.subject}</strong> a Steward of {s.where}.
              </li>
            ))}
          </ul>
          <button type="button" className="org-btn org-btn--primary" onClick={onOpenWaiting}>
            See all ({waitingLines})
          </button>
        </div>
      )}

      {people.people.length === 0 ? (
        <p className="home__muted">Nobody yet. Invite someone to start.</p>
      ) : (
        <table className="org-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Can do</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {people.people.map((p) => (
              <tr key={p.account}>
                <td>
                  <button type="button" className="org-link" onClick={() => onOpenPerson(p.account)}>
                    {p.name}
                  </button>
                  {p.you && <span className="org-tag">you</span>}
                  {p.email && <div className="org-sub">{p.email}</div>}
                </td>
                <td>{canDoWords(p)}</td>
                <td>
                  <span aria-hidden="true">{stateMark(p)}</span> {stateWords(p)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export interface PersonPageProps {
  person: Person;
  /** Folders the signed-in person stewards: where they can give more access. */
  folders: readonly Scope[];
  busy: boolean;
  error: string | null;
  notice: string | null;
  onBack: () => void;
  onRemove: (row: AccessRow) => void;
  onGive: (capability: Exclude<Asked, 'steward'>, scopeId: string) => void;
  onWithdraw: () => void;
  onOpenWaiting: () => void;
}

/** One person: exactly what they can do, in the folders you steward. */
export function PersonPage({ person, folders, busy, error, notice, onBack, onRemove, onGive, onWithdraw, onOpenWaiting }: PersonPageProps) {
  const [removing, setRemoving] = useState<string | null>(null);
  const [giving, setGiving] = useState(false);
  const [capability, setCapability] = useState<Exclude<Asked, 'steward'>>('draw');
  const [scope, setScope] = useState(folders[0]?.scopeId ?? '');
  const active = person.state === 'active';

  return (
    <section className="org-page">
      <button type="button" className="org-link" onClick={onBack}>
        ← People
      </button>
      <div className="org-page__title">
        {person.name}
        {person.you && <span className="org-tag">you</span>}
      </div>
      {person.email && <div className="org-sub">{person.email}</div>}
      <p className="home__muted">
        {stateMark(person)} {stateWords(person)}
      </p>
      {notice && <p className="org-note">{notice}</p>}
      {error && (
        <p className="home__error" role="alert">
          {error}
        </p>
      )}

      {active ? (
        <>
          <div className="home__label">Access in the folders you steward</div>
          {person.access.length === 0 && <p className="home__muted">None.</p>}
          <ul className="org-rows">
            {person.access.map((row) => {
              const blocked = whyNotRemovable(row, person.you);
              const open = removing === row.grant;
              return (
                <li key={row.grant} className="org-row">
                  <div className="org-row__main">
                    <strong>{accessWords(row.capability, row.scopeId, row.label)}</strong>
                    <span className="org-sub">
                      {row.inherited ? ' · from a folder above' : ''}
                      {row.expiresAtUnix !== null ? ` · until ${dateLabel(row.expiresAtUnix)}` : ''}
                      {row.awaitingSecond ? ' · waiting for a second steward' : ''}
                      {row.suspended ? ' · suspended' : ''}
                      {row.effectiveFromUnix * 1000 > Date.now()
                        ? ` · starts ${dateLabel(row.effectiveFromUnix)}, not yet in force`
                        : ` · since ${dateLabel(row.effectiveFromUnix)}`}
                    </span>
                    {open && <p className="org-note">{removalWords(row, person.name)}</p>}
                  </div>
                  <div className="org-row__actions">
                    {blocked === null && !open && (
                      <button type="button" className="org-btn" disabled={busy} onClick={() => setRemoving(row.grant)}>
                        Remove
                      </button>
                    )}
                    {open && (
                      <>
                        <button
                          type="button"
                          className="org-btn org-btn--primary"
                          disabled={busy}
                          onClick={() => {
                            setRemoving(null);
                            onRemove(row);
                          }}
                        >
                          {busy ? 'Signing…' : 'Sign and remove'}
                        </button>
                        <button type="button" className="org-btn" onClick={() => setRemoving(null)}>
                          Keep
                        </button>
                      </>
                    )}
                    {blocked !== null && <span className="org-sub">{blocked}</span>}
                  </div>
                </li>
              );
            })}
          </ul>

          {!giving && folders.length > 0 && (
            <div className="org-actions">
              <button type="button" className="org-btn" onClick={() => setGiving(true)}>
                Give more access
              </button>
            </div>
          )}
          {giving && (
            <form
              className="org-form"
              onSubmit={(e) => {
                e.preventDefault();
                setGiving(false);
                onGive(capability, scope);
              }}
            >
              <div className="org-form__title">Give {person.name} more access</div>
              <label className="org-field">
                <span className="org-field__label">What they can do</span>
                <select className="org-input" value={capability} onChange={(e) => setCapability(e.target.value as Exclude<Asked, 'steward'>)}>
                  <option value="read">{CAPABILITY_WORD.read}</option>
                  <option value="draw">{CAPABILITY_WORD.draw}</option>
                </select>
              </label>
              <label className="org-field">
                <span className="org-field__label">Where</span>
                <select className="org-input" value={scope} onChange={(e) => setScope(e.target.value)}>
                  {folders.map((f) => (
                    <option key={f.scopeId} value={f.scopeId}>
                      {f.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <p className="org-note">
                Signed in your browser. Making an existing person a Steward is not built yet; a Steward is appointed
                when you invite them.
              </p>
              <div className="org-actions">
                <button type="submit" className="org-btn org-btn--primary" disabled={busy || scope === ''}>
                  Sign and give access
                </button>
                <button type="button" className="org-btn" onClick={() => setGiving(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </>
      ) : (
        <>
          <div className="home__label">Invitation</div>
          <p>
            {person.asked ? `Asked for ${accessWords(person.asked.capability, person.asked.scopeId, person.asked.scopeLabel)}. ` : ''}
            {person.state === 'waiting'
              ? 'They have joined. Their access starts when you confirm them.'
              : 'They have not opened the link yet. They get no access until they have joined and you have confirmed them.'}
          </p>
          <div className="org-actions">
            {person.state === 'waiting' && (
              <button type="button" className="org-btn org-btn--primary" onClick={onOpenWaiting}>
                Go to Waiting for you
              </button>
            )}
            <button type="button" className="org-btn" disabled={busy} onClick={onWithdraw}>
              Withdraw the invitation
            </button>
          </div>
        </>
      )}
    </section>
  );
}
