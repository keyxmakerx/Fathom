// Outside vaults (ADR-0071 part four; mockup r32-vault-external; owner's answer "Make sure this is
// per user, but the Admin can reject/pull whatever as needed"). Each person connects their own
// Vaultwarden account, limited to one collection, or Delinea Secret Server account, limited to one
// folder, and pulls logins from it one at a time; an admin sees every connection, can disconnect
// any, and can remove any login pulled through one.

import { useState } from 'react';

import {
  KIND_LABELS,
  LOGIN_KINDS,
  outsideCheck,
  outsideConnect,
  outsideDelineaConnect,
  outsideDelineaPrepare,
  outsideDisconnect,
  outsidePrepare,
  outsidePull,
  outsideRemove,
  outsideRestore,
  PROVIDER_LABELS,
  type CheckLine,
  type LoginKind,
  type OutsideConnection,
  type OutsideItem,
  type OutsideLogin,
  type OutsideProvider,
  type UsedOn,
  type VaultOverview,
} from '../../api/vault';
import { openForConnect } from '../../vault/outside';
import { describeError } from '../design/useDesignSession';
import { VaultModal } from './Modal';
import { ago } from './parts';

/** A random collection name, so nobody files their own things there by mistake. */
export function suggestCollectionName(): string {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  const b = crypto.getRandomValues(new Uint8Array(4));
  return `fathom-${Array.from(b, (x) => a[x % a.length]).join('')}`;
}

const PROVIDERS: { id: OutsideProvider | 'passbolt'; mark: string; name: string; line: string }[] = [
  { id: 'vaultwarden', mark: 'VW', name: 'Vaultwarden or Bitwarden', line: 'A Fathom user, role User, in one collection' },
  { id: 'delinea', mark: 'DL', name: 'Delinea Secret Server', line: 'An account with View on one folder' },
  { id: 'passbolt', mark: 'PB', name: 'Passbolt', line: 'A Fathom user that holds only one shared folder' },
];

const BEFORE: Record<OutsideProvider, CheckLine[]> = {
  vaultwarden: [
    { id: 'role', passed: false, text: 'The account is a plain User, not Admin or Owner (those see every collection)' },
    { id: 'collection', passed: false, text: 'It can see 1 collection' },
    { id: 'personal', passed: false, text: 'Its own personal vault is empty, so nothing is mixed in' },
  ],
  delinea: [
    { id: 'collection', passed: false, text: 'It can see 1 folder' },
    { id: 'personal', passed: false, text: 'Every secret it can see is in that folder' },
  ],
};

function Checks({ lines, ran }: { lines: CheckLine[]; ran: boolean }) {
  return (
    <ul className="vault-checklist" data-testid="outside-checks">
      {lines.map((l) => (
        <li key={l.id} className={!ran ? 'vault-checklist__item' : l.passed ? 'vault-checklist__item vault-checklist__item--pass' : 'vault-checklist__item vault-checklist__item--fail'} data-check={l.id} data-passed={ran ? String(l.passed) : undefined}>
          <span aria-hidden="true">{!ran ? '○' : l.passed ? '✓' : '✕'}</span> {l.text}
        </li>
      ))}
      {!ran && (
        <li className="vault-checklist__item vault-muted">
          <span aria-hidden="true">✕</span> If any check fails, Fathom refuses to connect and says which.
        </li>
      )}
    </ul>
  );
}

export function ConnectOutsideDialog({ organisation, onClose, onDone }: { organisation: string; onClose: () => void; onDone: (c: OutsideConnection) => void }) {
  const [provider, setProvider] = useState<OutsideProvider>('vaultwarden');
  const [url, setUrl] = useState('https://');
  const [username, setUsername] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [needEmail, setNeedEmail] = useState(false);
  const [collection, setCollection] = useState(suggestCollectionName);
  const [lines, setLines] = useState<CheckLine[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = (p: OutsideProvider) => {
    setProvider(p);
    // Secret Server's folder is one made there already, so its name is typed, not suggested.
    setCollection(p === 'delinea' ? '' : suggestCollectionName());
    setLines(null);
    setError(null);
    setPassword('');
  };

  const connectDelinea = async () => {
    setError(null);
    setBusy('Reading the account…');
    try {
      const account = { url: url.trim(), username: username.trim(), password };
      const prep = await outsideDelineaPrepare(organisation, account);
      setLines(prep.checks);
      const failed = prep.checks.find((l) => !l.passed);
      if (failed) throw new Error(`Fathom will not connect: ${failed.text}.`);
      setBusy('Connecting…');
      const conn = await outsideDelineaConnect(organisation, { ...account, url: prep.url, folderName: collection.trim() });
      setPassword('');
      onDone(conn);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    if (provider === 'delinea') return connectDelinea();
    setError(null);
    setBusy('Reading the account…');
    try {
      const prep = await outsidePrepare(organisation, { url: url.trim(), clientId: clientId.trim(), clientSecret: clientSecret.trim() });
      setLines(prep.checks);
      const failed = prep.checks.find((l) => !l.passed);
      if (failed) throw new Error(`Fathom will not connect: ${failed.text}.`);
      if (prep.salt == null && !email.trim()) {
        setNeedEmail(true);
        throw new Error('This vault did not say which e-mail the account uses. Type it, then connect again.');
      }
      setBusy('Opening it in this browser…');
      const opened = await openForConnect(prep, password, email, collection);
      setBusy('Connecting…');
      const conn = await outsideConnect(organisation, {
        url: prep.url,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        deviceId: prep.deviceId,
        collectionId: opened.collectionId,
        collectionName: opened.collectionName,
        orgKey: opened.orgKey,
      });
      opened.orgKey.fill(0);
      setPassword('');
      onDone(conn);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const dl = provider === 'delinea';
  const ready = url.startsWith('https://') && url.length > 8 && password && collection.trim() && (dl ? username.trim() : clientId.trim() && clientSecret.trim());
  return (
    <VaultModal title="Connect an outside vault" onClose={onClose} wide testId="outside-connect">
      <div className="vault-outside">
        <div className="vault-form">
          <div className="vault-providers" role="radiogroup" aria-label="Which vault">
            {PROVIDERS.map((p) => {
              const id = p.id === 'passbolt' ? null : p.id;
              const pick = () => {
                if (id) choose(id);
              };
              return (
                <div
                  key={p.id}
                  className={id === provider ? 'vault-provider vault-provider--on' : 'vault-provider'}
                  role="radio"
                  aria-checked={id === provider}
                  aria-disabled={!id}
                  tabIndex={id ? 0 : -1}
                  onClick={pick}
                  onKeyDown={(e) => {
                    if (e.key === ' ' || e.key === 'Enter') {
                      e.preventDefault();
                      pick();
                    }
                  }}
                  data-testid={`outside-provider-${p.id}`}
                >
                  <span className="vault-provider__mark">{p.mark}</span>
                  <span className="vault-provider__text">
                    <strong>{p.name}</strong>
                    <span className="vault-muted">{p.line}</span>
                  </span>
                  {!id && <span className="vault-tag">Next</span>}
                </div>
              );
            })}
          </div>
          <label className="vault-field">
            <span className="vault-field__label">The vault’s address</span>
            <input className="vault-input vault-input--mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://vault.example.org" data-testid="outside-url" />
          </label>
          {dl && (
            <>
              <div className="vault-inline">
                <label className="vault-field">
                  <span className="vault-field__label">The account’s user name</span>
                  <input className="vault-input vault-input--mono" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" data-testid="outside-dl-user" />
                </label>
                <label className="vault-field">
                  <span className="vault-field__label">Its password</span>
                  <input className="vault-input" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="outside-dl-password" />
                </label>
              </div>
              <p className="vault-small">
                An account just for Fathom, with View on one folder and nothing else. Delinea advises an application account that cannot sign in to the web interface. One
                that needs a one-time code to sign in cannot be used.
              </p>
              <label className="vault-field">
                <span className="vault-field__label">Folder Fathom may use</span>
                <input className="vault-input vault-input--mono" value={collection} onChange={(e) => setCollection(e.target.value)} data-testid="outside-collection" />
                <span className="vault-small">Its name as Secret Server shows it. Fathom reads a secret’s user name and password, and nothing that needs a check-out or a comment first.</span>
              </label>
            </>
          )}
          {!dl && (
            <>
              <div className="vault-inline">
                <label className="vault-field">
                  <span className="vault-field__label">API client id</span>
                  <input className="vault-input vault-input--mono" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="user.…" data-testid="outside-client-id" />
                </label>
                <label className="vault-field">
                  <span className="vault-field__label">API client secret</span>
                  <input className="vault-input vault-input--mono" type="password" autoComplete="off" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} data-testid="outside-client-secret" />
                </label>
              </div>
              <p className="vault-small">In the vault, signed in as the account Fathom will use: Account settings › Security › Keys › View API key.</p>
              <label className="vault-field">
                <span className="vault-field__label">That account’s master password</span>
                <input className="vault-input" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="outside-master" />
                <span className="vault-small">Used in this browser to open the account once. It is never sent to Fathom’s server.</span>
              </label>
              {needEmail && (
                <label className="vault-field">
                  <span className="vault-field__label">That account’s e-mail</span>
                  <input className="vault-input" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="outside-email" />
                </label>
              )}
              <label className="vault-field">
                <span className="vault-field__label">Collection Fathom may use</span>
                <input className="vault-input vault-input--mono" value={collection} onChange={(e) => setCollection(e.target.value)} data-testid="outside-collection" />
                <span className="vault-small">A random name, so nobody files their own things there by mistake. Or give Fathom its own organisation.</span>
              </label>
            </>
          )}
          <div className="vault-field__label">Checked before it connects</div>
          <Checks lines={lines ?? BEFORE[provider]} ran={lines != null} />
          {error && (
            <p className="vault-error" role="alert">
              {error}
            </p>
          )}
          <div className="vault-actions">
            <button type="button" className="vault-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="vault-btn vault-btn--solid" disabled={!ready || busy != null} onClick={() => void connect()} data-testid="outside-connect-go">
              {busy ?? 'Connect'}
            </button>
          </div>
        </div>
        <aside className="vault-outside__notes">
          <p className="vault-note">
            <strong>Why so strict.</strong> Fathom’s account in your vault is a key to whatever that account can see. Keeping it to one{' '}
            {dl ? 'folder' : 'collection'} means a mistake in Fathom, or someone who takes over the Fathom server, can reach Fathom’s things and nobody
            else’s.
          </p>
          <p className="vault-note">
            Fathom checks again every time it reads. If the account has gained access to anything else, Fathom stops using it and tells
            the admins.
          </p>
          {dl && <p className="vault-note">Fathom can check what the account can see, not what it may do there. Give it View only; Fathom never changes a secret.</p>}
          <p className="vault-note vault-note--caution">
            Fathom keeps this account’s {dl ? 'user name and password' : 'API key'} so it can read without you. Treat it like a “Fathom may use” password: anyone who takes
            over the Fathom server can use it too.
          </p>
        </aside>
      </div>
    </VaultModal>
  );
}

function stateText(c: OutsideConnection): string {
  if (c.state === 'on') return c.checkedAt ? `On · checked ${ago(c.checkedAt)}` : 'On';
  if (c.state === 'stopped') return `Stopped: ${c.stoppedReason ?? 'a check failed'}`;
  return 'Disconnected';
}

function usedText(item: OutsideItem): string {
  const n = item.usedOn.length;
  return n === 0 ? 'not on a device yet' : n === 1 ? 'on 1 device' : `on ${n} devices`;
}

/** One connection, with its pulled logins; "Check now" lists the collection to pull from. */
function ConnectionCard({ organisation, overview, conn, onChanged }: { organisation: string; overview: VaultOverview; conn: OutsideConnection; onChanged: (note?: string) => void }) {
  const mine = conn.owner === overview.me;
  const can = mine || overview.steward;
  const [logins, setLogins] = useState<OutsideLogin[] | null>(null);
  const [kinds, setKinds] = useState<Record<string, LoginKind>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<unknown>, note?: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onChanged(note);
    } catch (e) {
      setError(describeError(e));
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const pulled = new Map(conn.items.map((i) => [i.cipherId, i]));
  return (
    <section className="vault-card" data-testid="outside-connection" data-state={conn.state}>
      <div className="vault-card__head">
        <span className="vault-card__name">
          {PROVIDER_LABELS[conn.provider]} · {conn.collectionName}
        </span>
        <span className={conn.state === 'on' ? 'vault-tag vault-tag--kept' : conn.state === 'stopped' ? 'vault-tag vault-tag--critical' : 'vault-tag'} data-testid="outside-state">
          {conn.state === 'on' ? 'On' : conn.state === 'stopped' ? 'Stopped' : 'Disconnected'}
        </span>
      </div>
      <p className="vault-small">
        {conn.url}
        {!mine && <> · connected by {conn.ownerName}</>} · {stateText(conn)}
      </p>
      {conn.items.length > 0 && (
        <ul className="vault-uses" data-testid="outside-items">
          {conn.items.map((i) => (
            <li key={i.id} className="vault-row" data-testid="outside-item" data-state={i.state}>
              <span>
                <strong>{i.name}</strong> <span className="vault-muted">{KIND_LABELS[i.kind]} · {usedText(i)}{i.reads > 0 ? ` · used ${i.reads} time${i.reads === 1 ? '' : 's'}` : ''}</span>
                {i.state === 'removed' && <span className="vault-caution"> · removed by {i.removedByName ?? 'someone'}</span>}
              </span>
              {can && i.state === 'on' && (
                <button type="button" className="vault-btn vault-btn--quiet" disabled={busy} onClick={() => void run(() => outsideRemove(organisation, i.id), `${i.name} is removed; Fathom no longer reads it.`)} data-testid="outside-remove">
                  Remove
                </button>
              )}
              {i.state === 'removed' && (overview.steward || (mine && i.removedBy === overview.me)) && (
                <button type="button" className="vault-btn vault-btn--quiet" disabled={busy} onClick={() => void run(() => outsideRestore(organisation, i.id))} data-testid="outside-restore">
                  Restore
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {logins && mine && conn.state === 'on' && (
        <div className="vault-fieldset" data-testid="outside-logins">
          <div className="vault-field__label">In {conn.collectionName}</div>
          {logins.length === 0 && <p className="vault-muted">{conn.provider === 'delinea' ? 'The folder holds no secrets yet.' : 'The collection holds no logins yet.'}</p>}
          {logins.map((l) => {
            const item = pulled.get(l.cipherId);
            return (
              <div key={l.cipherId} className="vault-row" data-testid="outside-login">
                <span>
                  {l.name}
                  {!l.hasPassword && <span className="vault-muted"> · no password Fathom can read</span>}
                </span>
                {item ? (
                  <span className="vault-muted">{item.state === 'removed' ? 'Removed' : 'In Fathom'}</span>
                ) : (
                  <span className="vault-inline">
                    <select className="vault-input vault-input--small" value={kinds[l.cipherId] ?? 'login'} onChange={(e) => setKinds({ ...kinds, [l.cipherId]: e.target.value as LoginKind })} aria-label={`What ${l.name} is`}>
                      {LOGIN_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {KIND_LABELS[k]}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="vault-btn"
                      disabled={busy || !l.hasPassword}
                      onClick={() => void run(() => outsidePull(organisation, conn.id, { cipherId: l.cipherId, kind: kinds[l.cipherId] ?? 'login', usedOn: [] }), `${l.name} is in Fathom. Mark the devices it is used on from a device’s Logins tab.`)}
                      data-testid="outside-pull"
                    >
                      Pull into Fathom
                    </button>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {error && (
        <p className="vault-error" role="alert">
          {error}
        </p>
      )}
      {can && conn.state !== 'disconnected' && (
        <div className="vault-card__acts">
          <button
            type="button"
            className="vault-btn"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await outsideCheck(organisation, conn.id);
                setLogins(r.logins);
              }, 'The checks passed.')
            }
            data-testid="outside-check"
          >
            {busy ? 'Checking…' : conn.state === 'stopped' ? 'Check again' : mine ? 'Check now and list its logins' : 'Check now'}
          </button>
          <button
            type="button"
            className="vault-btn vault-btn--quiet"
            disabled={busy}
            onClick={() => {
              if (window.confirm('Disconnect this vault? Fathom forgets its API key and stops reading it. The key itself still works in the vault until someone makes a new one there.'))
                void run(() => outsideDisconnect(organisation, conn.id), 'Disconnected. Make a new API key in the vault to retire the old one.');
            }}
            data-testid="outside-disconnect"
          >
            Disconnect
          </button>
        </div>
      )}
    </section>
  );
}

/** The "Outside vaults" section of Passwords (one's own) and of the admin's page (everyone's). */
export function OutsideVaults({ organisation, overview, mode, onChanged }: { organisation: string; overview: VaultOverview; mode: 'mine' | 'admin'; onChanged: () => void }) {
  const [connecting, setConnecting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const shown = mode === 'admin' ? overview.outside : overview.outside.filter((c) => c.owner === overview.me);
  return (
    <section className="vault-outside-section" data-testid="outside-vaults">
      <div className="vault-page__head">
        <h3 className="vault-h">{mode === 'admin' ? 'Outside vaults, everyone’s' : 'Outside vaults'}</h3>
        {mode === 'mine' && (
          <button type="button" className="vault-btn" onClick={() => setConnecting(true)} data-testid="outside-connect-open">
            + Connect an outside vault
          </button>
        )}
      </div>
      <p className="vault-muted">
        {mode === 'admin'
          ? 'Each person connects their own. You can disconnect any of them, and remove any login pulled through one; a login you remove stays out until an admin restores it.'
          : 'Logins Fathom reads from your own Vaultwarden or Secret Server, one collection or folder only, checked again on every read.'}
      </p>
      {note && <p className="vault-note">{note}</p>}
      {shown.length === 0 && <p className="vault-muted">{mode === 'admin' ? 'Nobody has connected one.' : 'None connected.'}</p>}
      {shown.map((c) => (
        <ConnectionCard
          key={c.id}
          organisation={organisation}
          overview={overview}
          conn={c}
          onChanged={(n) => {
            if (n) setNote(n);
            onChanged();
          }}
        />
      ))}
      {connecting && (
        <ConnectOutsideDialog
          organisation={organisation}
          onClose={() => setConnecting(false)}
          onDone={(c) => {
            setConnecting(false);
            setNote(`Connected to ${c.collectionName}. Check it now to list the logins you can pull.`);
            onChanged();
          }}
        />
      )}
    </section>
  );
}

/** On a device's Logins tab: the outside logins marked on it, and marking another. */
export function OutsideOnDevice({ organisation, overview, here, onChanged }: { organisation: string; overview: VaultOverview; here: UsedOn; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState('');
  const on = (i: OutsideItem) => i.usedOn.some((u) => u.design === here.design && u.element === here.element);
  const mineOn = overview.outside.filter((c) => c.owner === overview.me && c.state === 'on');
  const items = overview.outside.flatMap((c) => c.items.filter((i) => i.state === 'on').map((i) => ({ c, i })));
  const marked = items.filter(({ i }) => on(i));
  const markable = items.filter(({ c, i }) => !on(i) && c.owner === overview.me && c.state === 'on');
  const set = async (c: OutsideConnection, i: OutsideItem, usedOn: UsedOn[]) => {
    setBusy(true);
    setError(null);
    try {
      await outsidePull(organisation, c.id, { cipherId: i.cipherId, kind: i.kind, usedOn });
      onChanged();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  if (items.length === 0 && mineOn.length === 0) return null;
  return (
    <div className="vault-fieldset" data-testid="outside-on-device">
      <div className="vault-field__label">From outside vaults</div>
      {marked.length === 0 && <p className="vault-muted">None marked on this device.</p>}
      {marked.map(({ c, i }) => (
        <div key={i.id} className="vault-row" data-testid="outside-device-item">
          <span>
            <strong>{i.name}</strong> <span className="vault-tag vault-tag--fathom">{PROVIDER_LABELS[c.provider]} · {c.collectionName}</span>
          </span>
          {c.owner === overview.me && (
            <button type="button" className="vault-btn vault-btn--quiet" disabled={busy} onClick={() => void set(c, i, i.usedOn.filter((u) => !(u.design === here.design && u.element === here.element)))}>
              Not on this device
            </button>
          )}
        </div>
      ))}
      {markable.length > 0 && (
        <span className="vault-inline">
          <select className="vault-input vault-input--small" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="An outside login" data-testid="outside-device-pick">
            <option value="">An outside login…</option>
            {markable.map(({ i }) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="vault-btn"
            disabled={busy || !pick}
            onClick={() => {
              const found = markable.find(({ i }) => i.id === pick);
              if (found) void set(found.c, found.i, [...found.i.usedOn, here]).then(() => setPick(''));
            }}
            data-testid="outside-device-mark"
          >
            Used on this device
          </button>
        </span>
      )}
      {error && (
        <p className="vault-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
