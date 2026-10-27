// Adding or changing a login (mockups r32-vault-look and r32-vault-lockout-b). Who holds it is
// chosen here; the recovery sheet is always added when the organisation has one. A login only
// its owner holds says so, and needs a tick: it dies with their vault.

import { useEffect, useMemo, useState } from 'react';

import { KIND_LABELS, LOGIN_KINDS, recordBreach, type LoginKind, type UsedOn, type VaultEntry, type VaultOverview } from '../../api/vault';
import { effectivePolicy, timesBreached } from '../../vault/breach';
import type { Secret } from '../../vault/crypto';
import { chooseRecipients, holderAccounts, renameLogin, reshareLogin, storeLogin } from '../../vault/session';
import { describeError } from '../design/useDesignSession';
import { generatePassword } from '../../vault/generate';
import { VaultModal } from './Modal';
import type { VaultPlace } from './useVault';

export interface LoginDialogProps {
  organisation: string;
  overview: VaultOverview;
  place: VaultPlace | null;
  /** Absent to add one. */
  entry?: VaultEntry;
  /** The opened secret of `entry`, when changing it. */
  secret?: Secret;
  /** Devices to start with, when adding from a device's Logins tab. */
  usedOn?: UsedOn[];
  onDone: (entry: VaultEntry) => void;
  onClose: () => void;
}

export function LoginDialog({ organisation, overview, place, entry, secret, usedOn, onDone, onClose }: LoginDialogProps) {
  const [name, setName] = useState(entry?.name ?? '');
  const [kind, setKind] = useState<LoginKind>(entry?.kind ?? 'login');
  const [username, setUsername] = useState(secret?.username ?? '');
  const [password, setPassword] = useState(secret?.password ?? '');
  const [note, setNote] = useState(secret?.note ?? '');
  const [shown, setShown] = useState(false);
  const [devices, setDevices] = useState<UsedOn[]>(entry?.usedOn ?? usedOn ?? []);
  const [others, setOthers] = useState<string[]>(entry ? holderAccounts(entry).filter((a) => a !== overview.me) : []);
  const [aloneOk, setAloneOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A breached password the policy only warns of, which this person chose to keep: for which. */
  const [keptBreached, setKeptBreached] = useState<string | null>(null);
  const [breachNote, setBreachNote] = useState<{ times: number; refuse: boolean } | null>(null);

  const people = overview.people.filter((p) => p.account !== overview.me);
  const alone = others.length === 0 && overview.recovery == null;
  const removed = entry ? holderAccounts(entry).filter((a) => a !== overview.me && !others.includes(a)) : [];
  const secretChanged = entry != null && secret != null && (username !== secret.username || password !== secret.password || note !== secret.note);
  const holdersChanged = entry != null && (removed.length > 0 || others.some((a) => !holderAccounts(entry).includes(a)));
  const detailsChanged =
    entry != null && (name !== entry.name || kind !== entry.kind || JSON.stringify(devices) !== JSON.stringify(entry.usedOn));

  const deviceChoices = useMemo(() => {
    if (!place) return [];
    return place.deviceIds
      .map((id) => ({ id, name: place.deviceName(id) ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [place]);

  const toggleDevice = (id: string) => {
    if (!place) return;
    setDevices((d) => (d.some((u) => u.element === id && u.design === place.design) ? d.filter((u) => !(u.element === id && u.design === place.design)) : [...d, { design: place.design, element: id }]));
  };

  const policy = effectivePolicy(overview.breachPolicy, kind, entry?.critical ?? false);
  const newPassword = !entry || (secret != null && password !== secret.password);

  /** Checks a new password against the breach list where the policy says to. Answers whether to
   * go on, and how many breaches it was found in (null when not checked). */
  async function breachGate(): Promise<{ go: boolean; times: number | null }> {
    if (!policy.level.enabled || !newPassword || password === '') return { go: true, times: null };
    let times: number;
    try {
      times = await timesBreached(password);
    } catch {
      // The list could not be reached: saving is not held hostage to a third party. The login
      // shows "Not checked yet" and is checked at a later unlock.
      setBreachNote(null);
      return { go: true, times: null };
    }
    if (times === 0) return { go: true, times };
    const refuse = policy.level.action === 'refuse';
    setBreachNote({ times, refuse });
    if (refuse) return { go: false, times };
    return { go: keptBreached === password, times };
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const gate = await breachGate();
      if (!gate.go) return;
      const recipients = await chooseRecipients(organisation, overview, others);
      const done = (saved: VaultEntry) => {
        // Best effort: the record is what the list shows; a failure leaves it "Not checked yet".
        if (gate.times !== null) void recordBreach(organisation, saved.id, saved.epoch, gate.times > 0).catch(() => undefined);
        onDone(saved);
      };
      if (!entry) {
        done(await storeLogin(organisation, recipients, { name: name.trim(), kind, usedOn: devices, secret: { username, password, note } }));
        return;
      }
      let current = entry;
      if (detailsChanged) current = await renameLogin(organisation, entry.id, { ifVersion: current.version, name: name.trim(), kind, usedOn: devices });
      if (secretChanged || holdersChanged) {
        current = await reshareLogin(organisation, current, recipients, secretChanged ? 'changed' : 'shared', { username, password, note });
      }
      done(current);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const dropped = useDroppedPreview(organisation, overview, others);
  const valid = name.trim().length > 0 && (password.length > 0 || username.length > 0) && (!alone || aloneOk || entry != null);

  return (
    <VaultModal title={entry ? `Change ${entry.name}` : 'Add a login'} onClose={onClose} wide testId="vault-login-dialog">
      <form
        className="vault-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !busy) void save();
        }}
      >
        <div className="vault-row2">
          <label className="vault-field">
            <span className="vault-field__label">Name</span>
            <input className="vault-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="admin" data-testid="vault-name" />
          </label>
          <label className="vault-field">
            <span className="vault-field__label">Kind</span>
            <select className="vault-input" value={kind} onChange={(e) => setKind(e.target.value as LoginKind)}>
              {LOGIN_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="vault-small">The name is visible to admins. Do not put the password in it.</p>
        <div className="vault-row2">
          <label className="vault-field">
            <span className="vault-field__label">{kind === 'snmp' ? 'User or community name' : kind === 'wifi' ? 'Network name (SSID)' : 'User name'}</span>
            <input className="vault-input vault-input--mono" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} data-testid="vault-username" />
          </label>
          <label className="vault-field">
            <span className="vault-field__label">{kind === 'api' ? 'Key' : 'Password'}</span>
            <span className="vault-inline">
              <input
                className="vault-input vault-input--mono"
                type={shown ? 'text' : 'password'}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setBreachNote(null);
                }}
                autoComplete="new-password"
                spellCheck={false}
                data-testid="vault-password"
              />
              <button type="button" className="vault-btn btn-quiet" onClick={() => setShown(!shown)}>
                {shown ? 'Hide' : 'Show'}
              </button>
              <button
                type="button"
                className="vault-btn"
                onClick={() => {
                  setPassword(generatePassword());
                  setShown(true);
                  setBreachNote(null);
                }}
                data-testid="vault-generate"
              >
                Generate one
              </button>
            </span>
          </label>
        </div>
        <label className="vault-field">
          <span className="vault-field__label">Note (sealed with the password)</span>
          <textarea className="vault-input vault-textarea" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </label>

        {deviceChoices.length > 0 && (
          <fieldset className="vault-fieldset">
            <legend className="vault-field__label">Used on</legend>
            <div className="vault-choices">
              {deviceChoices.map((d) => (
                <label key={d.id} className="vault-check">
                  <input type="checkbox" checked={devices.some((u) => u.element === d.id && u.design === place?.design)} onChange={() => toggleDevice(d.id)} /> {d.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <fieldset className="vault-fieldset">
          <legend className="vault-field__label">Who holds it</legend>
          <p className="vault-small">
            You{overview.recovery ? ', and the recovery sheet, so a forgotten passphrase or a person leaving never loses it' : ''}. Add
            colleagues who need it:
          </p>
          <div className="vault-choices">
            {people.map((p) => (
              <label key={p.account} className={p.key ? 'vault-check' : 'vault-check vault-check--off'}>
                <input
                  type="checkbox"
                  disabled={!p.key}
                  checked={others.includes(p.account)}
                  onChange={() => setOthers((o) => (o.includes(p.account) ? o.filter((x) => x !== p.account) : [...o, p.account]))}
                />{' '}
                {p.name}
                {!p.key && <span className="vault-small"> · has not set up their vault</span>}
              </label>
            ))}
            {people.length === 0 && <p className="vault-small">Nobody else in the organisation yet.</p>}
          </div>
          {dropped.map((d) => (
            <p key={d.name} className="vault-note vault-note--danger" role="alert">
              {d.name} {d.why}. They will not be given this login.
            </p>
          ))}
          {removed.length > 0 && (
            <p className="vault-note vault-note--caution">
              Taking someone off stops Fathom handing them the password. If they ever saw it, change it on the device too.
            </p>
          )}
        </fieldset>

        {alone && !entry && (
          <div className="vault-note vault-note--caution" data-testid="vault-alone">
            <p>
              <strong>Nobody else has a copy of this.</strong> If you forget your passphrase, or leave, it is gone for good. Nobody at
              Fathom or in your organisation can get it back. Share it with a colleague to be safe.
            </p>
            <label className="vault-check">
              <input type="checkbox" checked={aloneOk} onChange={(e) => setAloneOk(e.target.checked)} data-testid="vault-alone-ok" /> I understand it dies with my vault
            </label>
          </div>
        )}

        {breachNote && breachNote.refuse && (
          <p className="vault-note vault-note--danger" role="alert" data-testid="vault-breached">
            This password is in a list of breached passwords ({breachNote.times.toLocaleString()} times), and{' '}
            {policy.from === 'critical' ? 'this login is marked critical' : 'your organisation refuses those'}. Choose another;
            Generate one makes one that is not.
          </p>
        )}
        {breachNote && !breachNote.refuse && (
          <div className="vault-note vault-note--caution" role="alert" data-testid="vault-breached">
            <p>
              This password is in a list of breached passwords ({breachNote.times.toLocaleString()} times). Anyone trying passwords
              against your devices tries these first.
            </p>
            <label className="vault-check">
              <input type="checkbox" checked={keptBreached === password} onChange={(e) => setKeptBreached(e.target.checked ? password : null)} data-testid="vault-breached-ok" /> Save it
              anyway
            </label>
          </div>
        )}
        {policy.level.enabled && newPassword && !breachNote && (
          <p className="vault-small">Checked against a list of breached passwords when you save. Only five characters of its hash leave this browser.</p>
        )}
        {error && (
          <p className="vault-error" role="alert">
            {error}
          </p>
        )}
        <div className="vault-actions">
          <button type="submit" className="vault-btn btn-main" disabled={!valid || busy || (entry != null && !secretChanged && !holdersChanged && !detailsChanged)} data-testid="vault-save">
            {busy ? 'Locking and saving…' : 'Save'}
          </button>
          <button type="button" className="vault-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </VaultModal>
  );
}

/** The people `chooseRecipients` will drop, shown before Save so nothing is a surprise. */
function useDroppedPreview(organisation: string, overview: VaultOverview, others: readonly string[]) {
  const [dropped, setDropped] = useState<{ name: string; why: string }[]>([]);
  const key = others.join(',');
  useEffect(() => {
    let live = true;
    void chooseRecipients(organisation, overview, others).then((r) => live && setDropped(r.dropped.filter((d) => !d.why.startsWith('has not set up'))));
    return () => {
      live = false;
    };
  }, [organisation, overview, key]);
  return dropped;
}
