import { useCallback, useEffect, useState, type FormEvent } from 'react';

import {
  createAccountShell,
  createOrganisationShell,
  issueAccountEnrolment,
  listOperators,
  listOrganisations,
  setAccountDisabled,
  type Invitation,
  type OperatorRow,
  type OrganisationRow,
} from '../../api/console';
import { ApiRefusal } from '../../api/errors';
import { toHex } from '../../crypto/bytes';
import './console.css';

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

  const refresh = useCallback(() => {
    setOperators({ status: 'loading' });
    setOrganisations({ status: 'loading' });
    listOperators()
      .then((value) => setOperators({ status: 'ready', value }))
      .catch((error: unknown) => setOperators({ status: 'error', message: describe(error) }));
    listOrganisations()
      .then((value) => setOrganisations({ status: 'ready', value }))
      .catch((error: unknown) => setOrganisations({ status: 'error', message: describe(error) }));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="console">
      <header className="console__head">
        <h1 className="console__title">Site</h1>
        <p className="console__who">
          Signed in as <code className="console__id">{operatorId}</code> · operator. That id is what you sign in with;
          the key that proves it is in this browser.
        </p>
      </header>

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
          render={(rows) => (
            <table className="console__table">
              <thead>
                <tr>
                  <th>id</th>
                  <th>name</th>
                  <th>created by</th>
                  <th>state</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className={row.disabled ? 'console__row--disabled' : undefined}>
                    <td>
                      <code>{row.id}</code>
                    </td>
                    <td>{row.displayName}</td>
                    <td>{row.createdBy ? <code>{row.createdBy}</code> : 'first start'}</td>
                    <td>
                      {row.disabled
                        ? 'disabled'
                        : row.neverIndependentlySignedIn
                          ? 'never independently signed in'
                          : 'active'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        />
        <p className="console__note">
          Requesting a colleague, and every settings change, needs a second operator and the delay, and an assertion
          signed by your enrolled key. Neither is on this board yet.
        </p>
        <button type="button" className="console__btn console__btn--quiet" onClick={refresh}>
          Refresh
        </button>
      </section>

      {minted.length > 0 && (
        <section className="console__section" aria-labelledby="console-minted">
          <h2 id="console-minted" className="console__h2">
            Issued in this session
          </h2>
          <p className="console__note">
            Shown here only until you sign out or reload. The server holds a hash of each token and cannot show it
            again; a lost invitation is replaced by issuing a new one.
          </p>
          <ul className="console__minted">
            {minted.map((m) => (
              <li key={m.invitation.tokenId} className="console__minted-row">
                <div className="console__minted-label">{m.label}</div>
                <div className="console__minted-meta">
                  {m.kind === 'organisation' ? 'shell' : 'account'} <code>{m.invitation.subject}</code> · expires{' '}
                  {formatUnix(m.invitation.expiresAtUnix)}
                </div>
                <code className="console__token">{toHex(m.invitation.token)}</code>
              </li>
            ))}
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

/** The server's own wording where it gave one (`../../api/errors.ts`), with
 * one addition this board can stand behind: a 404 on a console route is
 * what `admin_exposure.rs` answers when the console is confined to other
 * hosts or addresses than this request's, and an operator who sees it
 * needs to be told which door to try. */
function describe(error: unknown): string {
  if (error instanceof ApiRefusal) {
    if (error.status === 404) {
      return 'The console does not answer on this host or from this address (FATHOM_ADMIN_HOSTS, FATHOM_ADMIN_SOURCES).';
    }
    return error.retryAfterSeconds != null
      ? `${error.message} Try again in ${error.retryAfterSeconds}s.`
      : error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'That request did not complete.';
}

function formatUnix(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}
