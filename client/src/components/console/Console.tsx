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
  type OrganisationClaim,
  type OrganisationRow,
} from '../../api/console';
import { fetchBackupStatus } from '../../api/backups';
import { useConsoleHost } from '../../api/placement';
import { formatToken } from '../../api/enrolment';
import { describeConsoleError } from './describeConsoleError';
import { InvitationHandover } from './InvitationHandover';
import { NoticesBanner } from './NoticesBanner';
import { ConsoleTabs, consoleSections, type ConsoleSection } from './ConsoleTabs';
import { AiSection } from './AiSection';
import { FirmwareSection } from './FirmwareSection';
import { initialPageLink, showPageLink } from '../home/pageLink';
import { Operators } from './Operators';
import { PlacementForm } from './PlacementForm';
import { ActivityPanel } from './ActivityPanel';
import { DeviceReadingLine } from './DeviceReadingLine';
import { BackupsPanel } from './BackupsPanel';
import { SmtpForm } from './SmtpForm';
import { secondsLeft } from './placementCopy';
import { SkeletonRows } from '../ui/Skeleton';
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
  /** Pressing "Claim it now" hands the freshly minted claim up so the caller
   * can open the claim screen on Home with nothing to copy or paste. */
  onClaimNow?: (claim: OrganisationClaim) => void;
}

type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string };

/** One thing this board minted in this session, kept so the token stays
 * readable until the operator leaves. Not persisted anywhere: a token in
 * storage is a token in a backup. */
interface Minted {
  kind: 'account' | 'reissue' | 'organisation';
  label: string;
  invitation: Invitation;
  /** Only present for `kind === 'organisation'`: what
   * `redeemOrganisationClaim` needs. */
  claim?: OrganisationClaim;
}

export function Console({ operatorId, onClaimNow }: ConsoleProps) {
  const [operators, setOperators] = useState<Loaded<OperatorRow[]>>({ status: 'loading' });
  const [organisations, setOrganisations] = useState<Loaded<OrganisationRow[]>>({ status: 'loading' });
  const [minted, setMinted] = useState<Minted[]>([]);
  // One section at a time, Accounts first (owner, 2026-10-12).
  // `#admin/firmware` opens on Firmware (sign-off r71, "its own URL").
  const [section, setSectionState] = useState<ConsoleSection>(() => {
    const link = initialPageLink();
    return link?.tab === 'admin' && link.page === 'firmware' ? 'firmware' : 'accounts';
  });
  const setSection = useCallback((next: ConsoleSection) => {
    setSectionState(next);
    if (next === 'firmware') showPageLink({ tab: 'admin', page: 'firmware' });
  }, []);
  // A token is shown once and lives only under "Issued", so minting one takes
  // the person there: left on the form's tab they would see nothing happen.
  const onMinted = useCallback((m: Minted) => {
    setMinted((rows) => [m, ...rows]);
    setSection('issued');
  }, [setSection]);
  // ADR-0055 decision 9: whether the console answers on the host this page
  // was served from. Read once per page load, before a control is rendered.
  const consoleHost = useConsoleHost();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  // **The page arrives whole.** The banner, the tabs and the lists each wait
  // on a request of their own; drawn as each came back, the banner landed
  // last and pushed everything below it down (owner, 2026-10-26: "things
  // loaded separately"). So the board below the heading waits for the first
  // round, and a quick answer shows no loading shapes at all.
  const [firstLoadDone, setFirstLoadDone] = useState(false);

  // **A refresh does not put the lists back to `loading`.** `ListBlock`
  // renders nothing but a word while a list is loading, so doing that would
  // unmount the register — and with it the add-a-colleague form that has
  // just asked for this refresh and is holding the server's answer about
  // what it requested. Observed in the ADR-0055 drive: the request applied,
  // the confirmation vanished. The first load still shows `loading`,
  // because that is the state the component starts in.
  const refresh = useCallback(() => {
    const lists = [
      listOperators()
        .then((value) => setOperators({ status: 'ready', value }))
        .catch((error: unknown) => setOperators({ status: 'error', message: describe(error) })),
      listOrganisations()
        .then((value) => setOrganisations({ status: 'ready', value }))
        .catch((error: unknown) => setOrganisations({ status: 'error', message: describe(error) })),
    ];
    // A notice that cannot be fetched is not a notice that does not exist,
    // but there is nothing honest to show in its place: the banner stays
    // empty and the section errors below say what failed.
    // Backup notices (ADR-0070) join the same banner: a failed backup or an
    // out-of-date keys file is a standing fact, like the rest.
    const banner = Promise.all([fetchNotices(), fetchBackupStatus().catch(() => null)])
      .then(([standing, backups]) =>
        setNotices([
          ...standing,
          ...(backups?.notices ?? []).map((line): Notice => ({ kind: 'backup', line })),
        ]),
      )
      .catch(() => {});
    void Promise.all([...lists, banner]).then(() => setFirstLoadDone(true));
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
        <SkeletonRows label="Checking whether Admin is available here…" rows={3} />
      </div>
    );
  }
  if (consoleHost.status === 'ready' && !consoleHost.flag.consoleHost) {
    return (
      <div className="console console__absent">
        <p>
          Admin is not available at <code>{host}</code>. This server shows Admin only at another address, so
          nothing from Admin appears here.
        </p>
        <p>
          The address is set either by <code>FATHOM_ADMIN_HOSTS</code> and <code>FATHOM_ADMIN_SOURCES</code> on
          the server, or under Settings › Where Admin answers. Go to the address Admin was moved to and sign in
          there.
        </p>
      </div>
    );
  }
  if (consoleHost.status === 'error') {
    return (
      <div className="console console__absent">
        <p>
          This browser could not check whether Admin is available at <code>{host}</code>:{' '}
          {consoleHost.message} Nothing from Admin is shown until it can.
        </p>
      </div>
    );
  }

  return (
    <div className="console">
      {/* The page's title and tabs are Home's (ADR-0060 decision 7); this says whose acts these are. */}
      <p className="console__who">
        Signed in as <code className="console__id">{operatorId}</code>, a server admin, on <code>{host}</code>. Your
        sign-in key is kept in this browser, and everything you do here is signed with it.
      </p>
      <p className="console__note">For whoever runs this server: accounts, organisations, mail, backups.</p>

      {!firstLoadDone ? (
        <SkeletonRows label="Loading Admin…" rows={5} />
      ) : (
      <>
      <NoticesBanner
        notices={notices}
        pendingConfirmByUnix={pendingConfirmBy}
        pendingSecondsLeft={pendingConfirmBy === null ? null : secondsLeft(pendingConfirmBy, now)}
        host={host}
      />

      <ConsoleTabs sections={consoleSections(minted.length > 0)} current={section} onSelect={setSection} />

      {section === 'accounts' && (
        <section className="console__section" aria-labelledby="console-accounts">
          <h2 id="console-accounts" className="console__h2">
            Accounts
          </h2>
          <p className="console__note">
            A new account stays empty until the person opens their invitation and sets up sign-in in their browser.
            Fathom does not email invitations: copy the code from Invitations and give it to them yourself. Each
            code works once and runs out.
          </p>
          <AccountForm onMinted={onMinted} />
          <ReissueForm onMinted={onMinted} />
          <DisableForm />
        </section>
      )}

      {section === 'organisations' && (
        <section className="console__section" aria-labelledby="console-organisations">
          <h2 id="console-organisations" className="console__h2">
            Organisations
          </h2>
          <p className="console__note">
            Admin sees only each organisation's name. It cannot open its designs, racks or cables.
          </p>
          <ListBlock
            loaded={organisations}
            empty="No organisation exists yet."
            render={(rows) => (
              <table className="console__table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Name</th>
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
          <OrganisationForm onMinted={onMinted} />
        </section>
      )}

      {section === 'operators' && (
        <section className="console__section" aria-labelledby="console-operators">
          <h2 id="console-operators" className="console__h2">
            Server admins
          </h2>
          <ListBlock
            loaded={operators}
            empty="No server admin is registered, which cannot be: you are one."
            render={(rows) => <Operators actingOperatorId={operatorId} rows={rows} onChanged={refresh} />}
          />
          <button type="button" className="console__btn" onClick={refresh}>
            Refresh
          </button>
        </section>
      )}

      {section === 'ai' && (
        <section className="console__section" aria-labelledby="console-ai">
          <h2 id="console-ai" className="console__h2">
            AI on this server
          </h2>
          <AiSection organisations={organisations.status === 'ready' ? organisations.value : []} />
        </section>
      )}

      {section === 'firmware' && (
        <section className="console__section" aria-labelledby="console-firmware">
          <h2 id="console-firmware" className="console__h2">
            Firmware
          </h2>
          <FirmwareSection organisations={organisations.status === 'ready' ? organisations.value : []} />
        </section>
      )}

      {section === 'activity' && (
        <section className="console__section" aria-labelledby="console-activity">
          <h2 id="console-activity" className="console__h2">
            Activity
          </h2>
          <ActivityPanel />
        </section>
      )}

      {section === 'settings' && (
        <section className="console__section" aria-labelledby="console-settings">
          <h2 id="console-settings" className="console__h2">
            Settings
          </h2>
          <p className="console__note">
            Mail and the address Admin answers on are set here, not in a file. Changing them here needs no restart,
            which keeps you from being locked out in the middle of a move.
          </p>
          <SmtpForm actingOperatorId={operatorId} />
          <PlacementForm actingOperatorId={operatorId} currentHost={host} />
          <BackupsPanel />
          <DeviceReadingLine />
        </section>
      )}

      {section === 'issued' && minted.length > 0 && (
        <section className="console__section" aria-labelledby="console-minted">
          <h2 id="console-minted" className="console__h2">
            Invitations made this session
          </h2>
          <p className="console__note">
            Shown here only until you sign out or reload. The server cannot show a code again; a lost invitation is
            replaced by making a new one. The start of the code says what it is for (<code>inv_</code> an account
            invitation, <code>org_</code> an organisation's setup link); the sign-up screen reads it, so the person
            just pastes the code and their email.
          </p>
          <ul className="console__minted">
            {minted.map((m) => {
              const token = formatToken(
                m.invitation.token,
                m.kind === 'organisation' ? 'organisation' : 'steward',
              );
              const claim = m.kind === 'organisation' ? m.claim : undefined;
              return (
                <li key={m.invitation.tokenId} className="console__minted-row">
                  <div className="console__minted-label">{m.label}</div>
                  <div className="console__minted-meta">
                    {m.kind === 'organisation' ? 'organisation' : 'account'} <code>{m.invitation.subject}</code> · expires{' '}
                    {formatUnix(m.invitation.expiresAtUnix)}
                  </div>
                  {/* An organisation claim has no address to hand over; only
                      the token and notice address below, or "Claim it now". */}
                  {claim ? (
                    <>
                      <p className="console__note">
                        Contact email <code>{claim.noticeAddress}</code> -- the setup screen asks
                        for this alongside the code when it is pasted in rather than opened from
                        here.
                      </p>
                      {onClaimNow && (
                        <button type="button" className="console__btn btn-main" onClick={() => onClaimNow(claim)}>
                          Claim it now
                        </button>
                      )}
                    </>
                  ) : (
                    <InvitationHandover token={token} origin={origin} />
                  )}
                  <code className="console__token">{token}</code>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      </>
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
  if (loaded.status === 'loading') return <SkeletonRows rows={3} />;
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
        className="console__btn btn-main"
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
      <div className="console__form-title">Make a new invitation</div>
      <p className="console__note">
        Use this when someone lost their invitation, it ran out, or they need to set up sign-in again. It is made
        out to the email already on the account; you cannot choose another.
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
      <button type="submit" className="console__btn btn-main" disabled={busy || accountId.trim().length === 0}>
        {busy ? 'Making…' : 'Make'}
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
      <div className="console__form-title">Turn an account off or on</div>
      <p className="console__note">
        Turning an account off stops sign-in straight away. It does not remove what the person can do inside an
        organisation. A Steward of that organisation does that.
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
          className="console__btn btn-main"
          disabled={busy || accountId.trim().length === 0}
          onClick={() => act(true)}
        >
          Turn off
        </button>
        <button
          type="button"
          className="console__btn"
          disabled={busy || accountId.trim().length === 0}
          onClick={() => act(false)}
        >
          Turn on
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
      const claim = await createOrganisationShell(displayName.trim());
      onMinted({
        kind: 'organisation',
        label: `Setup link for the new organisation "${displayName.trim()}"`,
        invitation: claim,
        claim,
      });
      setDisplayName('');
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="console__form" onSubmit={submit}>
      <div className="console__form-title">New organisation</div>
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
      <button type="submit" className="console__btn btn-main" disabled={busy || displayName.trim().length === 0}>
        {busy ? 'Creating…' : 'Create the organisation and its setup link'}
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
