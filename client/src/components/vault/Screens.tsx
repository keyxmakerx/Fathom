// The vault's screens (mockups design r32-vault-*): a device's Logins tab, Inventory › Passwords,
// and the admin's Passwords page. Each loads the organisation's vault itself, so the three can
// never disagree about who holds what.

import { useContext, useState, type ReactNode } from 'react';

import type { VaultEntry, VaultOverview } from '../../api/vault';
import type { Secret } from '../../vault/crypto';
import { coverWithCurrentKeys, makeRecoverySheet, recoverLogins, removeLogin, revealLogin, takeAwayCopy, vaultUnlocked } from '../../vault/session';
import { describeError } from '../design/useDesignSession';
import { LoginDialog } from './LoginDialog';
import { VaultModal } from './Modal';
import { SetupDialog } from './SetupDialog';
import { UnlockDialog } from './UnlockDialog';
import { Fingerprint, KitSheet, ago, canRead, checkDue, clearCheck, copyForAWhile, holdersText, kindText, vaultReady } from './parts';
import { useVault, VaultPlaceContext, type Vault, type VaultPlace } from './useVault';

import './vault.css';

type Dialog =
  | { kind: 'setup' }
  | { kind: 'unlock'; then?: () => void }
  | { kind: 'add' }
  | { kind: 'change'; entry: VaultEntry; secret: Secret }
  | { kind: 'sheet'; code: string }
  | { kind: 'recover'; entry: VaultEntry }
  | null;

/** The dialogs, the "set up / unlock" strip, and acts that need an unlocked vault. */
function useVaultActs(vault: Vault, organisationName: string, place: VaultPlace | null, usedOn?: { design: string; element: string }[]) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const overview = vault.load.status === 'ready' ? vault.load.value : null;

  const afterUnlock = (o: VaultOverview) => {
    // Keep the recovery sheet and replaced keys covering everything this person holds.
    void coverWithCurrentKeys(vault.organisation, o)
      .then((n) => {
        if (n > 0) setNotice(`${n === 1 ? 'One login was' : `${n} logins were`} shared again so the recovery sheet and current keys cover ${n === 1 ? 'it' : 'them'}.`);
        if (n > 0) vault.reload();
      })
      .catch(() => undefined);
  };

  /** Run `act` unlocked: asks for the passphrase first when locked. */
  const whenUnlocked = (act: () => void) => {
    if (!overview) return;
    if (!vaultReady(overview)) setDialog({ kind: 'setup' });
    else if (vaultUnlocked(vault.organisation)) act();
    else setDialog({ kind: 'unlock', then: act });
  };

  const dialogs: ReactNode =
    overview && dialog ? (
      dialog.kind === 'setup' ? (
        <SetupDialog
          organisation={vault.organisation}
          organisationName={organisationName}
          overview={overview}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            vault.reload();
          }}
        />
      ) : dialog.kind === 'unlock' ? (
        <UnlockDialog
          organisation={vault.organisation}
          overview={overview}
          onClose={() => setDialog(null)}
          onDone={() => {
            const then = dialog.then;
            setDialog(null);
            clearCheck(vault.organisation, overview.me);
            afterUnlock(overview);
            then?.();
          }}
        />
      ) : dialog.kind === 'add' || dialog.kind === 'change' ? (
        <LoginDialog
          organisation={vault.organisation}
          overview={overview}
          place={place}
          entry={dialog.kind === 'change' ? dialog.entry : undefined}
          secret={dialog.kind === 'change' ? dialog.secret : undefined}
          usedOn={usedOn}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            vault.reload();
          }}
        />
      ) : dialog.kind === 'sheet' ? (
        <VaultModal title="Print the recovery sheet now" onClose={() => setDialog(null)} wide testId="vault-sheet-made">
          <p>
            This code opens every login the sheet holds, with an admin signed in. Fathom shows it only now. Print it and keep it in the
            safe.
          </p>
          <KitSheet kind="sheet" organisationName={organisationName} code={dialog.code} fingerprint={overview.recovery?.fpr} />
          <div className="vault-actions">
            <button type="button" className="vault-btn vault-btn--solid" onClick={() => setDialog(null)} data-testid="vault-sheet-done">
              I have printed it
            </button>
          </div>
        </VaultModal>
      ) : dialog.kind === 'recover' ? (
        <RecoverDialog vault={vault} overview={overview} entry={dialog.entry} onClose={() => setDialog(null)} onDone={(n) => {
          setDialog(null);
          setNotice(n > 0 ? 'Shared again from the recovery sheet. It is in the organisation’s history, and every admin can see it.' : 'Nothing was opened.');
          vault.reload();
        }} />
      ) : null
    ) : null;

  return { overview, dialog, setDialog, dialogs, whenUnlocked, notice, setNotice };
}

/** The strip above any vault list: set up, unlock, or the 3-day passphrase check. */
function VaultStrip({ vault, overview, onSetup, onUnlock }: { vault: Vault; overview: VaultOverview; onSetup: () => void; onUnlock: () => void }) {
  if (!vaultReady(overview)) {
    return (
      <div className="vault-strip" data-testid="vault-strip-setup">
        <span>Set up your vault to store and read logins. It takes a minute: an Emergency Kit to save, and a passphrase.</span>
        <button type="button" className="vault-btn vault-btn--solid" onClick={onSetup} data-testid="vault-setup-open">
          Set up your vault
        </button>
      </div>
    );
  }
  if (!vault.unlocked) {
    const due = checkDue(vault.organisation, overview.me);
    return (
      <div className={due ? 'vault-strip vault-strip--caution' : 'vault-strip'} data-testid="vault-strip-locked">
        <span>{due ? 'Check you still have your passphrase: unlock once, now, while forgetting it costs nothing.' : 'Locked. Passwords show once you unlock.'}</span>
        <button type="button" className="vault-btn vault-btn--solid" onClick={onUnlock} data-testid="vault-unlock-open">
          Unlock
        </button>
      </div>
    );
  }
  return null;
}

function SecretLine({ vault, entry, onChange }: { vault: Vault; entry: VaultEntry; onChange?: (secret: Secret) => void }) {
  const [secret, setSecret] = useState<Secret | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const open = async (): Promise<Secret | null> => {
    try {
      const s = secret ?? (await revealLogin(vault.organisation, entry));
      setSecret(s);
      return s;
    } catch (e) {
      setError(describeError(e));
      return null;
    }
  };
  if (!canRead(entry)) return <span className="vault-muted">•••••••••••• — not shared with you</span>;
  if (!vault.unlocked) return <span className="vault-mask">••••••••••••••</span>;
  return (
    <span className="vault-secret">
      {secret ? (
        <span className="vault-secret__plain" data-testid="vault-plain">
          {secret.username && <code>{secret.username}</code>}
          <code>{secret.password}</code>
        </span>
      ) : (
        <span className="vault-mask">••••••••••••••</span>
      )}
      <button type="button" className="vault-btn vault-btn--quiet" onClick={() => (secret ? setSecret(null) : void open())} data-testid="vault-show">
        {secret ? 'Hide' : 'Show'}
      </button>
      <button
        type="button"
        className="vault-btn vault-btn--quiet"
        onClick={() =>
          void open().then((s) => {
            if (!s) return;
            void copyForAWhile(s.password).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
          })
        }
        title="Copied passwords leave the clipboard after 30 seconds"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      {onChange && (
        <button type="button" className="vault-btn vault-btn--quiet" onClick={() => void open().then((s) => s && onChange(s))} data-testid="vault-change">
          Change
        </button>
      )}
      {secret?.note && <span className="vault-small vault-secret__note">{secret.note}</span>}
      {error && (
        <span className="vault-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

function LoginCard({ vault, overview, entry, onChange, onRemove }: { vault: Vault; overview: VaultOverview; entry: VaultEntry; onChange?: (s: Secret) => void; onRemove?: () => void }) {
  return (
    <div className="vault-card" data-testid="vault-card">
      <div className="vault-card__head">
        <span className="vault-card__name">{entry.name}</span>
        <span className="vault-tag">{kindText(entry)}</span>
        <span className="vault-tag vault-tag--kept" title="Locked in the browser; the server cannot open it">
          Only people
        </span>
      </div>
      <SecretLine vault={vault} entry={entry} onChange={onChange} />
      <div className="vault-small">
        {holdersText(entry, overview.me)} · changed {ago(entry.updatedAt)}
        {entry.needsRotation && <strong className="vault-caution"> · someone was taken off: change it on the device</strong>}
        {onRemove && (
          <>
            {' · '}
            <button type="button" className="vault-link" onClick={onRemove}>
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function usedOnText(entry: VaultEntry, place: VaultPlace | null): string {
  if (entry.usedOn.length === 0) return '—';
  if (!place) return entry.usedOn.length === 1 ? '1 device' : `${entry.usedOn.length} devices`;
  const here = entry.usedOn.filter((u) => u.design === place.design).map((u) => place.deviceName(u.element) ?? 'a removed device');
  const elsewhere = entry.usedOn.length - here.length;
  if (here.length > 3) return `${here.length} devices`;
  return [...here, ...(elsewhere > 0 ? [`${elsewhere} in other designs`] : [])].join(', ');
}

/** A device's Logins tab. */
export function LoginsTab({ deviceId }: { deviceId: string }) {
  const place = useContext(VaultPlaceContext);
  if (!place) return <p className="vault-muted">Logins are kept with a saved design.</p>;
  return <LoginsTabBody place={place} deviceId={deviceId} organisationName={place.organisationName} />;
}

/** How many passwords this person can read in the organisation, for Inventory's side list. */
export function useVaultCount(organisation: string): number | null {
  const vault = useVault(organisation);
  return vault.load.status === 'ready' ? vault.load.value.entries.filter(canRead).length : null;
}

/** "Logins 2": the tab's label, with how many the vault lists for this device once loaded. */
export function LoginsTabLabel({ deviceId }: { deviceId: string }) {
  const place = useContext(VaultPlaceContext);
  const vault = useVault(place?.organisation ?? '');
  const n =
    place && vault.load.status === 'ready'
      ? vault.load.value.entries.filter((e) => e.usedOn.some((u) => u.design === place.design && u.element === deviceId)).length
      : 0;
  return (
    <>
      Logins{n > 0 ? <span className="vault-count"> {n}</span> : null}
    </>
  );
}

function LoginsTabBody({ place, deviceId, organisationName }: { place: VaultPlace; deviceId: string; organisationName: string }) {
  const vault = useVault(place.organisation);
  const here = [{ design: place.design, element: deviceId }];
  const acts = useVaultActs(vault, organisationName, place, here);
  if (vault.load.status === 'loading') return <p className="vault-muted">Loading logins…</p>;
  if (vault.load.status === 'error') return <p className="vault-error">{vault.load.message}</p>;
  const overview = vault.load.value;
  const mine = overview.entries.filter((e) => e.usedOn.some((u) => u.design === place.design && u.element === deviceId));
  return (
    <div className="vault-tab" data-testid="vault-logins-tab">
      <VaultStrip vault={vault} overview={overview} onSetup={() => acts.setDialog({ kind: 'setup' })} onUnlock={() => acts.setDialog({ kind: 'unlock' })} />
      {acts.notice && <p className="vault-note">{acts.notice}</p>}
      {mine.length === 0 && <p className="vault-muted">No logins for this device yet.</p>}
      {mine.map((e) => (
        <LoginCard key={e.id} vault={vault} overview={overview} entry={e} onChange={(secret) => acts.setDialog({ kind: 'change', entry: e, secret })} />
      ))}
      <div className="vault-actions">
        <button type="button" className="vault-btn" onClick={() => acts.whenUnlocked(() => acts.setDialog({ kind: 'add' }))} data-testid="vault-add">
          + Add a login
        </button>
      </div>
      <details className="vault-about">
        <summary>What a login is in Fathom</summary>
        <p>
          The vault records which devices use this login; the design itself holds nothing of it. Exports, diagrams, prints and the
          inventory never carry the password.
        </p>
        <p>
          Locked in your browser before it was sent, so a stolen copy of the database or a backup holds only scrambled bytes. A server
          someone has taken over while you use it is a different risk: it could send this page altered code. That is why admins and
          the recovery sheet are announced, and why a login only you hold says so.
        </p>
      </details>
      {acts.dialogs}
    </div>
  );
}

/** Inventory › Passwords (mode `mine`) and the admin's Passwords page (mode `admin`). */
export function PasswordsPage({ organisation, organisationName, mode: asked }: { organisation: string; organisationName: string; mode: 'mine' | 'admin' }) {
  const place = useContext(VaultPlaceContext);
  const vault = useVault(organisation);
  const acts = useVaultActs(vault, organisationName, place);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (vault.load.status === 'loading') return <p className="vault-muted vault-page">Loading passwords…</p>;
  if (vault.load.status === 'error') return <p className="vault-error vault-page">{vault.load.message}</p>;
  const overview = vault.load.value;
  // The admin page shows everything only to an admin; anyone else sees their own, as in Inventory.
  const mode = asked === 'admin' && overview.steward ? 'admin' : 'mine';
  const rows = mode === 'admin' ? overview.entries : overview.entries.filter(canRead);
  const open = rows.find((e) => e.id === openId) ?? null;

  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      vault.reload();
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <div className="vault-page" data-testid={mode === 'admin' ? 'vault-admin' : 'vault-passwords'}>
      <div className="vault-page__head">
        <h2 className="vault-page__title">{mode === 'admin' ? 'Every password in the organisation' : 'Passwords'}</h2>
        {mode === 'mine' && (
          <button type="button" className="vault-btn" onClick={() => acts.whenUnlocked(() => acts.setDialog({ kind: 'add' }))} data-testid="vault-add">
            + Add a password
          </button>
        )}
      </div>
      {mode === 'admin' && (
        <p className="vault-muted">You see that each one exists, who holds it and how old it is. You read only the ones shared with you, the same as anyone.</p>
      )}
      <VaultStrip vault={vault} overview={overview} onSetup={() => acts.setDialog({ kind: 'setup' })} onUnlock={() => acts.setDialog({ kind: 'unlock' })} />
      {acts.notice && <p className="vault-note">{acts.notice}</p>}
      {error && (
        <p className="vault-error" role="alert">
          {error}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="vault-muted">{mode === 'admin' ? 'No passwords are stored in this organisation yet.' : 'No passwords are shared with you yet.'}</p>
      ) : (
        <table className="vault-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Used on</th>
              <th>{mode === 'admin' ? 'Held by' : 'Who holds it'}</th>
              <th>How Fathom keeps it</th>
              <th>Changed</th>
              <th>Breach list</th>
              {mode === 'admin' && <th>You</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className={e.id === openId ? 'vault-table__row vault-table__row--on' : 'vault-table__row'} onClick={() => setOpenId(e.id === openId ? null : e.id)} data-testid="vault-row">
                <td>
                  <button type="button" className="vault-link vault-link--strong">
                    {e.name}
                  </button>
                </td>
                <td>{usedOnText(e, place)}</td>
                <td>{holdersText(e, overview.me)}</td>
                <td>Only people</td>
                <td>{ago(e.updatedAt)}</td>
                <td className="vault-muted" title="Breach-list checks come in a later build">
                  Not checked yet
                </td>
                {mode === 'admin' && <td>{canRead(e) ? 'Can read' : <span className="vault-muted">Can’t read</span>}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && (
        <div className="vault-detail" data-testid="vault-detail">
          <LoginCard
            vault={vault}
            overview={overview}
            entry={open}
            onChange={canRead(open) ? (secret) => acts.setDialog({ kind: 'change', entry: open, secret }) : undefined}
            onRemove={
              open.owner === overview.me || overview.steward
                ? () => {
                    if (window.confirm(`Delete ${open.name}? Fathom stops keeping it. Anyone who saw it still knows it.`)) void act(() => removeLogin(organisation, open.id, open.version));
                  }
                : undefined
            }
          />
          {(open.owner === overview.me || overview.steward) && (
            <div className="vault-holders">
              <div className="vault-field__label">Remove someone</div>
              {open.holders
                .filter((h) => !h.revoked && h.kind === 'person' && h.account !== open.owner)
                .map((h) => (
                  <div key={h.keyId} className="vault-holder">
                    <span>{h.name}</span> <Fingerprint fpr={h.fpr} />
                    <button type="button" className="vault-btn vault-btn--quiet" onClick={() => void act(() => takeAwayCopy(organisation, open.id, open.version, h.keyId))}>
                      Remove
                    </button>
                  </div>
                ))}
              <p className="vault-small">Removing someone stops Fathom handing them the password. Changing the password on the device is what actually locks them out.</p>
            </div>
          )}
          {mode === 'admin' && !canRead(open) && overview.recovery && open.holders.some((h) => h.kind === 'recovery' && !h.revoked) && (
            <button type="button" className="vault-btn" onClick={() => acts.setDialog({ kind: 'recover', entry: open })} data-testid="vault-recover-open">
              Open with the recovery sheet…
            </button>
          )}
          {mode === 'admin' && (
            <p className="vault-small">What an admin can always do: see it’s here, take access away, delete it. What an admin can’t: read it, or give themselves a copy without the recovery sheet.</p>
          )}
        </div>
      )}
      {mode === 'admin' && <RecoveryCard overview={overview} onMake={() => void act(async () => acts.setDialog({ kind: 'sheet', code: await makeRecoverySheet(overview, organisation) }))} />}
      {acts.dialogs}
    </div>
  );
}

function RecoveryCard({ overview, onMake }: { overview: VaultOverview; onMake: () => void }) {
  return (
    <section className="vault-card vault-recovery" data-testid="vault-recovery-card">
      <div className="vault-card__head">
        <span className="vault-card__name">Recovery sheet</span>
      </div>
      {overview.recovery ? (
        <>
          <p className="vault-small">
            Made {ago(overview.recovery.enrolledAt * 1000)}. Fingerprint <Fingerprint fpr={overview.recovery.fpr} />. Added to every new
            password, so a forgotten passphrase or a person leaving never loses one.
          </p>
          {overview.recoveryUses.length > 0 ? (
            <ul className="vault-uses">
              {overview.recoveryUses.map((u, i) => (
                <li key={i}>
                  Opened by {u.byName} {ago(u.at)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="vault-small">Never used.</p>
          )}
          <button type="button" className="vault-btn vault-btn--quiet" onClick={onMake}>
            Replace the sheet…
          </button>
        </>
      ) : (
        <>
          <p className="vault-small">
            Without one, a login whose holders all forget their passphrase, or leave, is gone for good. Make one, print it, and keep it
            in the safe. Using it needs the sheet and an admin signed in, and every use is written to the organisation’s history.
          </p>
          <button type="button" className="vault-btn vault-btn--solid" onClick={onMake} data-testid="vault-make-sheet">
            Make the recovery sheet
          </button>
        </>
      )}
    </section>
  );
}

function RecoverDialog({ vault, overview, entry, onClose, onDone }: { vault: Vault; overview: VaultOverview; entry: VaultEntry; onClose: () => void; onDone: (n: number) => void }) {
  const [code, setCode] = useState('');
  const [to, setTo] = useState<string[]>([overview.me]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const people = overview.people.filter((p) => p.key);
  return (
    <VaultModal title={`Open ${entry.name} with the recovery sheet`} onClose={onClose} testId="vault-recover">
      <p className="vault-note vault-note--caution">
        This is written to the organisation’s history before anything is opened, and every admin sees it on this page.
      </p>
      <label className="vault-field">
        <span className="vault-field__label">Recovery code, from the sheet</span>
        <input className="vault-input vault-input--mono" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} data-testid="vault-recovery-code" />
      </label>
      <fieldset className="vault-fieldset">
        <legend className="vault-field__label">Give it to</legend>
        {people.map((p) => (
          <label key={p.account} className="vault-check">
            <input type="checkbox" checked={to.includes(p.account)} onChange={() => setTo((t) => (t.includes(p.account) ? t.filter((x) => x !== p.account) : [...t, p.account]))} />{' '}
            {p.account === overview.me ? 'You' : p.name}
          </label>
        ))}
      </fieldset>
      {error && (
        <p className="vault-error" role="alert">
          {error}
        </p>
      )}
      <div className="vault-actions">
        <button
          type="button"
          className="vault-btn vault-btn--solid"
          disabled={busy || code.trim() === '' || to.length === 0}
          onClick={() => {
            setBusy(true);
            setError(null);
            recoverLogins(vault.organisation, overview, code, [entry.id], to).then(onDone, (e: unknown) => {
              setError(describeError(e));
              setBusy(false);
            });
          }}
          data-testid="vault-recover-go"
        >
          {busy ? 'Opening…' : 'Open and share'}
        </button>
        <button type="button" className="vault-btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </VaultModal>
  );
}
