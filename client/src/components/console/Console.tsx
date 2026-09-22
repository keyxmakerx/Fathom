import { useCallback, useEffect, useState, type FormEvent } from 'react';

import {
  createAccountShell,
  createOrganisationShell,
  fetchNotices,
  issueAccountEnrolment,
  listOperators,
  listOrganisations,
  setAccountDisabled,
  type Invitation,
  type Notice,
  type OperatorRow,
  type OrganisationRow,
} from '../../api/console';
import { useConsoleHost } from '../../api/placement';
import { formatToken } from '../../api/enrolment';
import { describeConsoleError } from './describeConsoleError';
import { InvitationHandover } from './InvitationHandover';
import { NoticesBanner } from './NoticesBanner';
import { Operators } from './Operators';
import { PlacementForm } from './PlacementForm';
import { SmtpForm } from './SmtpForm';
import { secondsLeft } from './placementCopy';
import './console.css';
import '../../styles/console.css';

/**
 * The operator console -- `docs/UI-SPEC.md`'s "Operator console" row and
 * the Site board of the screens set, as far as the server's verbs reach
 * today (`../../api/console.ts` says what is not here and why).
 *
 * Every write here mints or changes something an operator answers for, and
 * every token shown is shown once: the server keeps only a hash
 * (`admin.rs`: *"the token is answered once and never again"*). Nothing is
 * emailed in this build, so the token is handed over out of band by the
 * operator reading it off this board.
 */
export interface ConsoleProps {
  /** The signed-in operator's id (`sessionState.address` for an operator
   * session) -- shown, because it is what they sign in with next time. */
  operatorId: string;
}

type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string };

/** One thing this board minted in this session, kept so the token stays
 * readable until the operator leaves. Not persisted anywhere: a token in
 * storage is a token in a backup. */
interface Minted {
  kind: 'account' | 'reissue' | 'organisation';
  label: string;
  invitation: Invitation;
}

export function Console({ operatorId }: ConsoleProps) {
  const [operators, setOperators] = useState<Loaded<OperatorRow[]>>({ status: 'loading' });
  const [organisations, setOrganisations] = useState<Loaded<OrganisationRow[]>>({ status: 'loading' });
  const [minted, setMinted] = useState<Minted[]>([]);
  // ADR-0055 decision 9: whether the console answers on the host this page
  // was served from. Read once per page load, before a control is rendered.
  const consoleHost = useConsoleHost();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  // **A refresh does not put the lists back to `loading`.** `ListBlock`
  // renders nothing but a word while a list is loading, so doing that would
  // unmount the register — and with it the add-a-colleague form that has
  // just asked for this refresh and is holding the server's answer about
  // what it requested. Observed in the ADR-0055 drive: the request applied,
  // the confirmation vanished. The first load still shows `loading`,
  // because that is the state the component starts in.
  const refresh = useCallback(() => {
    listOperators()
      .then((value) => setOperators({ status: 'ready', value }))
      .catch((error: unknown) => setOperators({ status: 'error', message: describe(error) }));
    listOrganisations()
      .then((value) => setOrganisations({ status: 'ready', value }))
      .catch((error: unknown) => setOrganisations({ status: 'error', message: describe(error) }));
    // A notice that cannot be fetched is not a notice that does not exist,
    // but there is nothing honest to show in its place: the banner stays
    // empty and the section errors below say what failed.
    fetchNotices()
      .then(setNotices)
      .catch(() => {});
  }, []);

  // **Nothing is asked of the console on a host the console does not answer
  // on.** Decision 9's "absent, not hidden" covers the requests too: three
  // 404s in the network log would be three operator requests this client
  // made from a host where it had been told not to.
  const answersHere = consoleHost.status === 'ready' && consoleHost.flag.consoleHost;
  useEffect(() => {
    if (answersHere) refresh();
  }, [answersHere, refresh]);

  // The one clock the pending-placement banner counts down on.
  const pendingConfirmBy =
    consoleHost.status === 'ready' ? consoleHost.flag.confirmByUnix : null;
  useEffect(() => {
    if (pendingConfirmBy === null) return;
    const tick = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(tick);
  }, [pendingConfirmBy]);

  const host = typeof window === 'undefined' ? '' : window.location.host;
  // The scheme and host this page was served from, for the invitation
  // address beside every minted token (ADR-0056 decision 6). Read here rather
  // than in the leaf so there is one place that touches `window`.
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  // Decision 9, literally: on a host the console does not answer on, every
  // operator control is ABSENT. Not disabled, not hidden — this component
  // returns before any of them is created.
  if (consoleHost.status === 'loading') {
    return (
      <div className="console">
        <p className="console__muted">Asking the server whether this host answers for the console…</p>
      </div>
    );
  }
  if (consoleHost.status === 'ready' && !consoleHost.flag.consoleHost) {
    return (
      <div className="console console__absent">
        <h1 className="console__title">Site</h1>
        <p>
          The operator console does not answer on <code>{host}</code>. Nothing operator-side is offered here, and
          nothing here would be answered if it were: the server replies 404 to every console path on this host.
        </p>
        <p>
          The console is confined either by <code>FATHOM_ADMIN_HOSTS</code> / <code>FATHOM_ADMIN_SOURCES</code> on
          the server, or by a placement set in the console itself. Go to the host it was moved to and sign in
          there.
        </p>
      </div>
    );
  }
  if (consoleHost.status === 'error') {
    return (
      <div className="console console__absent">
        <h1 className="console__title">Site</h1>
        <p>
          This browser could not establish whether the console answers on <code>{host}</code>:{' '}
          {consoleHost.message} Nothing operator-side is offered until it can — an unanswered question is not a
          yes.
        </p>
      </div>
    );
  }

  return (
    <div className="console">
      <header className="console__head">
        <h1 className="console__title">Site</h1>
        <p className="console__who">
          Signed in as <code className="console__id">{operatorId}</code> · operator, on <code>{host}</code>. The key
          that proves it is in this browser, and every operator act below is signed with it.
        </p>
      </header>

      <NoticesBanner
        notices={notices}
        pendingConfirmByUnix={pendingConfirmBy}
        pendingSecondsLeft={pendingConfirmBy === null ? null : secondsLeft(pendingConfirmBy, now)}
        host={host}
      />

      <section className="console__section" aria-labelledby="console-accounts">
        <h2 id="console-accounts" className="console__h2">
          Accounts
        </h2>
        <p className="console__note">
          An account is a shell until its person redeems an invitation, which puts a key in their browser. There is
          nothing to email an invitation with in this build: read the token off this board and hand it over
          yourself. Each token works once and expires.
        </p>
        <AccountForm onMinted={(m) => setMinted((rows) => [m, ...rows])} />
        <ReissueForm onMinted={(m) => setMinted((rows) => [m, ...rows])} />
        <DisableForm />
      </section>

      <section className="console__section" aria-labelledby="console-organisations">
        <h2 id="console-organisations" className="console__h2">
          Organisations
        </h2>
        <p className="console__note">
          Names in the clear, everything below them opaque: no design, rack or cable is reachable from here.
        </p>
        <ListBlock
          loaded={organisations}
          empty="No organisation exists yet."
          render={(rows) => (
            <table className="console__table">
              <thead>
                <tr>
                  <th>id</th>
                  <th>name</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <code>{row.id}</code>
                    </td>
                    <td>{row.displayName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        />
        <OrganisationForm onMinted={(m) => setMinted((rows) => [m, ...rows])} />
        <p className="console__warn">
          A shell's claim cannot be redeemed in this build: the steward-side route that runs an organisation's
          genesis is not built yet (<code>docs/NEXT.md</code>). The shell and its token are recorded on the site
          trail; the organisation itself waits for that route.
        </p>
      </section>

      <section className="console__section" aria-labelledby="console-operators">
        <h2 id="console-operators" className="console__h2">
          Operators
        </h2>
        <ListBlock
          loaded={operators}
          empty="No operator is registered, which cannot be: you are one."
          render={(rows) => <Operators actingOperatorId={operatorId} rows={rows} onChanged={refresh} />}
        />
        <button type="button" className="console__btn console__btn--quiet" onClick={refresh}>
          Refresh
        </button>
      </section>

      <section className="console__section" aria-labelledby="console-settings">
        <h2 id="console-settings" className="console__h2">
          Settings
        </h2>
        <p className="console__note">
          Two settings live here rather than in a file, on the owner's instruction: mail, because an install with
          no mail path cannot tell anybody anything; and where this console answers, because moving it from a file
          means a restart, and a restart in the middle of a move is how a lockout happens.
        </p>
        <SmtpForm actingOperatorId={operatorId} />
        <PlacementForm actingOperatorId={operatorId} currentHost={host} />
      </section>

      {minted.length > 0 && (
        <section className="console__section" aria-labelledby="console-minted">
          <h2 id="console-minted" className="console__h2">
            Issued in this session
          </h2>
          <p className="console__note">
            Shown here only until you sign out or reload. The server holds a hash of each token and cannot show it
            again; a lost invitation is replaced by issuing a new one. The prefix says what the token is for
            (<code>inv_</code> an account invitation, <code>org_</code> an organisation claim); the enrolment
            screen reads it, so the person just pastes the token and their address.
          </p>
          <ul className="console__minted">
            {minted.map((m) => {
              const token = formatToken(
                m.invitation.token,
                m.kind === 'organisation' ? 'organisation' : 'steward',
              );
              return (
                <li key={m.invitation.tokenId} className="console__minted-row">
                  <div className="console__minted-label">{m.label}</div>
                  <div className="console__minted-meta">
                    {m.kind === 'organisation' ? 'shell' : 'account'} <code>{m.invitation.subject}</code> · expires{' '}
                    {formatUnix(m.invitation.expiresAtUnix)}
                  </div>
                  {/* ADR-0056 decision 6: the address is what is handed over,
                      and the bare token stays beside it for whoever would
                      rather paste one into the enrolment screen. Both are
                      the same invitation. */}
                  <InvitationHandover token={token} origin={origin} />
                  <code className="console__token">{token}</code>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

function ListBlock<T>({
  loaded,
  empty,
  render,
}: {
  loaded: Loaded<T[]>;
  empty: string;
  render: (rows: T[]) => React.ReactNode;
}) {
  if (loaded.status === 'loading') return <p className="console__muted">Loading…</p>;
  if (loaded.status === 'error') return <p className="console__error">{loaded.message}</p>;
  if (loaded.value.length === 0) return <p className="console__muted">{empty}</p>;
  return <>{render(loaded.value)}</>;
}

function AccountForm({ onMinted }: { onMinted: (m: Minted) => void }) {
  const [address, setAddress] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const invitation = await createAccountShell(address.trim(), displayName.trim());
      onMinted({ kind: 'account', label: `Invitation for ${address.trim()} (${displayName.trim()})`, invitation });
      setAddress('');
      setDisplayName('');
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="console__form" onSubmit={submit}>
      <div className="console__form-title">New account</div>
      <label className="console__label" htmlFor="console-account-address">
        Address
      </label>
      <input
        id="console-account-address"
        className="console__input"
        type="text"
        autoComplete="off"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        disabled={busy}
        required
      />
      <label className="console__label" htmlFor="console-account-name">
        Display name
      </label>
      <input
        id="console-account-name"
        className="console__input"
        type="text"
        autoComplete="off"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        disabled={busy}
        required
      />
      <button
        type="submit"
        className="console__btn"
        disabled={busy || address.trim().length < 3 || displayName.trim().length === 0}
      >
        {busy ? 'Creating…' : 'Create the account and its invitation'}
      </button>
      {error && (
        <p className="console__error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function ReissueForm({ onMinted }: { onMinted: (m: Minted) => void }) {
  const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const invitation = await issueAccountEnrolment(accountId.trim());
      onMinted({ kind: 'reissue', label: `New invitation for account ${accountId.trim()}`, invitation });
      setAccountId('');
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="console__form" onSubmit={submit}>
      <div className="console__form-title">Issue a new invitation</div>
      <p className="console__note">
        For an account whose invitation was lost or has expired, or whose key must be replaced. The token goes to
        the account's own address of record; there is no field to send it elsewhere.
      </p>
      <label className="console__label" htmlFor="console-reissue-id">
        Account id
      </label>
      <input
        id="console-reissue-id"
        className="console__input console__input--mono"
        type="text"
        autoComplete="off"
        value={accountId}
        onChange={(e) => setAccountId(e.target.value)}
        disabled={busy}
        required
      />
      <button type="submit" className="console__btn" disabled={busy || accountId.trim().length === 0}>
        {busy ? 'Issuing…' : 'Issue'}
      </button>
      {error && (
        <p className="console__error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function DisableForm() {
  const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function act(disabled: boolean) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await setAccountDisabled(accountId.trim(), disabled);
      setDone(`Account ${accountId.trim()} ${disabled ? 'disabled' : 're-enabled'}.`);
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="console__form" onSubmit={(e) => e.preventDefault()}>
      <div className="console__form-title">Disable or re-enable an account</div>
      <p className="console__note">
        Disabling stops sign-in at once. It does not touch the account's grants inside any organisation; a steward
        there revokes those.
      </p>
      <label className="console__label" htmlFor="console-disable-id">
        Account id
      </label>
      <input
        id="console-disable-id"
        className="console__input console__input--mono"
        type="text"
        autoComplete="off"
        value={accountId}
        onChange={(e) => setAccountId(e.target.value)}
        disabled={busy}
      />
      <div className="console__row">
        <button
          type="button"
          className="console__btn"
          disabled={busy || accountId.trim().length === 0}
          onClick={() => act(true)}
        >
          Disable
        </button>
        <button
          type="button"
          className="console__btn console__btn--quiet"
          disabled={busy || accountId.trim().length === 0}
          onClick={() => act(false)}
        >
          Re-enable
        </button>
      </div>
      {done && <p className="console__muted">{done}</p>}
      {error && (
        <p className="console__error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function OrganisationForm({ onMinted }: { onMinted: (m: Minted) => void }) {
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const invitation = await createOrganisationShell(displayName.trim());
      onMinted({ kind: 'organisation', label: `Claim for the organisation shell "${displayName.trim()}"`, invitation });
      setDisplayName('');
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="console__form" onSubmit={submit}>
      <div className="console__form-title">New organisation shell</div>
      <label className="console__label" htmlFor="console-org-name">
        Display name
      </label>
      <input
        id="console-org-name"
        className="console__input"
        type="text"
        autoComplete="off"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        disabled={busy}
        required
      />
      <button type="submit" className="console__btn" disabled={busy || displayName.trim().length === 0}>
        {busy ? 'Creating…' : 'Create the shell and its claim'}
      </button>
      {error && (
        <p className="console__error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** The server's own wording where it gave one, in one place now that four
 * components need it: `./describeConsoleError.ts`. */
function describe(error: unknown): string {
  return describeConsoleError(error);
}

function formatUnix(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}
