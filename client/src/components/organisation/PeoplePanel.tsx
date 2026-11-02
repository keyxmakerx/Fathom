import { useState } from 'react';

import type { Asked } from '../../api/invitations';
import type { AccessRow, People, Person } from '../../api/people';
import type { Scope } from '../../api/scopes';
import { accessDetail, accessWords, canDoWords, CAPABILITY_WORD, contactLine, removalWords, stateMark, stateWords, whyNotRemovable } from './model';

export interface PeopleListProps {
  people: People;
  /** Joined people and steward requests waiting on this steward. */
  needsYou: { joined: { name: string; asked: string }[]; seconding: { granter: string | null; subject: string; where: string }[] };
  onOpenPerson: (account: string) => void;
  onInvite: () => void;
  onOpenWaiting: () => void;
  /** Turn Termix off, or back on, for everyone here (ADR-0078 decision 6). */
  onSetTermixEveryone?: (off: boolean) => void;
  /** ADR-0080 decision 9: a steward turns Fetch from Termix on or off for everyone here. */
  onSetTermixFetch?: (on: boolean) => void;
  busy?: boolean;
}

/** Everyone, what they can do where, and whether they are in yet. */
export function PeopleList({ people, needsYou, onOpenPerson, onInvite, onOpenWaiting, onSetTermixEveryone, onSetTermixFetch, busy = false }: PeopleListProps) {
  const waitingLines = needsYou.joined.length + needsYou.seconding.length;
  return (
    <section className="org-page">
      <div className="home__section-head">
        <div className="org-page__title">People</div>
        <button type="button" className="org-btn btn-main" onClick={onInvite}>
          Add someone
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
          <button type="button" className="org-btn btn-main" onClick={onOpenWaiting}>
            See all ({waitingLines})
          </button>
        </div>
      )}

      {people.people.length === 0 ? (
        <p className="home__muted">Nobody yet. Add someone to start.</p>
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
                  {contactLine(p) && <div className="org-sub">{contactLine(p)}</div>}
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

      {people.termix && onSetTermixEveryone && (
        <div className="org-box" data-testid="people-termix">
          <div className="home__label">Termix</div>
          <p className="org-note">
            {people.termixOff
              ? 'Off for everyone here. Nobody in this organisation sees Open in Termix or Send to Termix.'
              : 'On. Each person opens devices in Termix with their own Termix key. You can turn it off for everyone here, or for one person on their page.'}{' '}
            This hides it in Fathom; taking Termix from someone is done in Termix, by revoking their key.
          </p>
          <div className="org-actions">
            <button type="button" className="org-btn" disabled={busy} onClick={() => onSetTermixEveryone(!people.termixOff)}>
              {people.termixOff ? 'Turn on for everyone' : 'Turn off for everyone'}
            </button>
          </div>
          {!people.termixOff && onSetTermixFetch && (
            <div data-testid="people-termix-fetch">
              <div className="home__label">Fetch from Termix</div>
              <p className="org-note">
                {people.termixFetch
                  ? 'On. A check step offers Fetch from Termix: Termix runs the step’s own command, only from a fixed read-only list for the device’s platform, and the answer is redacted in the browser like a paste. Fathom never acts on what it read.'
                  : 'Off. A check step has its paste box only. Turned on, a check step also offers Fetch from Termix, which runs only read-only commands (show and the like) and never leads Fathom to act.'}
              </p>
              <div className="org-actions">
                <button type="button" className="org-btn" disabled={busy} onClick={() => onSetTermixFetch(!people.termixFetch)}>
                  {people.termixFetch ? 'Turn Fetch from Termix off' : 'Turn Fetch from Termix on'}
                </button>
              </div>
            </div>
          )}
        </div>
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
  /** Switch "type it yourself" on or off for them. */
  onSetTyping?: (on: boolean) => void;
  /** Turn Termix off, or back on, for them (ADR-0078 decision 6). Absent when there is no Termix. */
  onSetTermix?: (off: boolean) => void;
  /** A steward turned Termix off for everyone here, which outranks this person's own switch. */
  termixOffForEveryone?: boolean;
  /** Draw the page with the Withdraw question already asked (a test seam, like `refusing`). */
  withdrawing?: boolean;
}

/** One person: exactly what they can do, in the folders you steward. */
export function PersonPage({ person, folders, busy, error, notice, onBack, onRemove, onGive, onWithdraw, onOpenWaiting, onSetTyping, onSetTermix, termixOffForEveryone = false, withdrawing: withdrawingFirst = false }: PersonPageProps) {
  const [removing, setRemoving] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(withdrawingFirst);
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
      {contactLine(person) && <div className="org-sub">{contactLine(person)}</div>}
      <p className="home__muted">
        <span aria-hidden="true">{stateMark(person)}</span> {stateWords(person)}
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
                    <div className="org-sub">{accessDetail(row, Date.now())}</div>
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
                          className="org-btn btn-main"
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
          {onSetTyping && (
            <div className="org-box" data-testid="person-typing">
              <div className="home__label">Type it yourself</div>
              <p className="org-note">
                {person.typeItYourself
                  ? `On. Commands are shown to ${person.you ? 'you' : person.name} to be typed by hand, in labelled parts, with no copy button. Links and hashes still copy.`
                  : `Off. Turn it on and commands are shown to ${person.you ? 'you' : person.name} to be typed by hand, in labelled parts, with no copy button. Links and hashes still copy.`}{' '}
                {person.you ? '' : 'They can turn it on for themselves, but only a steward turns it off.'}
              </p>
              <div className="org-actions">
                <button type="button" className="org-btn" disabled={busy} onClick={() => onSetTyping(!person.typeItYourself)}>
                  {person.typeItYourself ? 'Turn off' : 'Turn on'}
                </button>
              </div>
            </div>
          )}

          {onSetTermix && (
            <div className="org-box" data-testid="person-termix">
              <div className="home__label">Termix</div>
              <p className="org-note">
                {termixOffForEveryone
                  ? 'Off for everyone in this organisation, which covers them too. Turn it back on from People.'
                  : person.termixOff
                    ? `Off for ${person.you ? 'you' : person.name}. Open in Termix and Send to Termix are hidden from ${person.you ? 'you' : 'them'} here.`
                    : `On. ${person.you ? 'You open' : `${person.name} opens`} devices in Termix with ${person.you ? 'your' : 'their'} own Termix key.`}{' '}
                Taking Termix from someone is done in Termix, by revoking their key.
              </p>
              {!termixOffForEveryone && (
                <div className="org-actions">
                  <button type="button" className="org-btn" disabled={busy} onClick={() => onSetTermix(!person.termixOff)}>
                    {person.termixOff ? 'Turn on' : 'Turn off'}
                  </button>
                </div>
              )}
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
                <button type="submit" className="org-btn btn-main" disabled={busy || scope === ''}>
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
              <button type="button" className="org-btn btn-main" onClick={onOpenWaiting}>
                Go to Waiting for you
              </button>
            )}
            {withdrawing ? (
              <>
                <button type="button" className="org-btn btn-main" disabled={busy} onClick={onWithdraw}>
                  Withdraw it for {person.name}
                </button>
                <button type="button" className="org-btn" onClick={() => setWithdrawing(false)}>
                  Keep
                </button>
              </>
            ) : (
              <button type="button" className="org-btn" disabled={busy} onClick={() => setWithdrawing(true)}>
                Withdraw the invitation
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
