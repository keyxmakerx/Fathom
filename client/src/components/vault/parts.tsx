// Small pieces the vault screens share.

import { useEffect, useState } from 'react';

import { KIND_LABELS, type VaultEntry, type VaultOverview } from '../../api/vault';
import { fingerprintText } from '../../vault/crypto';
import { readPref, writePref } from '../../prefs';
import { getSession } from '../../state/sessionState';

const DAY = 86_400_000;

// Without storage the check simply never comes due.
const store = writePref;

const checkSlot = (organisation: string, account: string) => `fathom.vault.check.${organisation}.${account}`;

/** Ask for the passphrase once, three days after setup, while forgetting it still costs nothing. */
export function rememberCheck(organisation: string, account: string): void {
  store(checkSlot(organisation, account), String(Date.now() + 3 * DAY));
}

export function checkDue(organisation: string, account: string): boolean {
  const at = Number(readPref(checkSlot(organisation, account)) ?? '');
  return Number.isFinite(at) && at > 0 && Date.now() >= at;
}

export function clearCheck(organisation: string, account: string): void {
  store(checkSlot(organisation, account), null);
}

export function ago(ms: number): string {
  const days = Math.floor((Date.now() - ms) / DAY);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 60) return `${days} days ago`;
  if (days < 730) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

/** "You, Sam Ortiz, recovery sheet": who holds a login now. */
export function holdersText(entry: VaultEntry, me: string): string {
  const live = entry.holders.filter((h) => !h.revoked);
  const people = live.filter((h) => h.kind === 'person').sort((a, b) => (a.account === me ? -1 : b.account === me ? 1 : a.name.localeCompare(b.name)));
  const names = people.map((h) => (h.account === me ? 'You' : h.name) + (h.stale ? ' (old key)' : ''));
  if (live.some((h) => h.kind === 'recovery')) names.push('recovery sheet');
  return names.length ? names.join(', ') : 'Nobody';
}

export function kindText(entry: VaultEntry): string {
  return KIND_LABELS[entry.kind];
}

/** Whether `me` holds a copy the server will hand over. */
export const canRead = (entry: VaultEntry): boolean => entry.opening != null;

export function Fingerprint({ fpr }: { fpr: Uint8Array }) {
  return <code className="vault-fpr">{fingerprintText(fpr)}</code>;
}

/** A code to keep: the Emergency Kit's vault key or the recovery sheet's secret, with Copy,
 * Download and Print. Printing shows only this sheet. */
export function KitSheet({ kind, organisationName, code, fingerprint }: { kind: 'kit' | 'sheet'; organisationName: string; code: string; fingerprint?: Uint8Array }) {
  const [copied, setCopied] = useState(false);
  const title = kind === 'kit' ? 'Emergency Kit' : 'Vault recovery sheet';
  const lines = [
    `Fathom ${title}`,
    organisationName,
    '',
    kind === 'kit' ? 'Vault key:' : 'Recovery code:',
    code,
    '',
    kind === 'kit'
      ? 'Your vault opens with this key and your passphrase together. Fathom cannot show it again.'
      : 'Keep in the safe. Using it needs this sheet and an admin signed in. Every use is written to the organisation’s history.',
    ...(fingerprint ? ['', `Fingerprint: ${fingerprintText(fingerprint)}`] : []),
  ];
  const download = () => {
    const url = URL.createObjectURL(new Blob([`${lines.join('\n')}\n`], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = kind === 'kit' ? 'Fathom Emergency Kit.txt' : 'Fathom vault recovery sheet.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  const print = () => {
    document.body.classList.add('vault-printing');
    const done = () => {
      document.body.classList.remove('vault-printing');
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
  };
  return (
    <div className={kind === 'kit' ? 'vault-kit' : 'vault-kit vault-kit--sheet'} data-testid={kind === 'kit' ? 'vault-kit-sheet' : 'vault-recovery-sheet'}>
      <div className="vault-kit__head">
        <span className="vault-kit__brand">FATHOM</span>
        <span>{organisationName}</span>
      </div>
      <div className="vault-kit__title">{title}</div>
      <code className="vault-kit__code" data-testid="vault-code">
        {code.split('-').map((g, i) => (
          <span key={i}>{g}</span>
        ))}
      </code>
      {fingerprint && (
        <p className="vault-small">
          Fingerprint: <Fingerprint fpr={fingerprint} />
        </p>
      )}
      <div className="vault-actions vault-kit__actions">
        <button type="button" className="vault-btn" onClick={download}>
          Download
        </button>
        <button
          type="button"
          className="vault-btn"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="vault-btn" onClick={print}>
          Print
        </button>
      </div>
    </div>
  );
}

/** Clears the clipboard 30 seconds after a password is copied, if it still holds that password. */
export function copyForAWhile(text: string): Promise<void> {
  return navigator.clipboard.writeText(text).then(() => {
    setTimeout(() => {
      void navigator.clipboard
        .readText()
        .then((now) => (now === text ? navigator.clipboard.writeText('') : undefined))
        .catch(() => undefined);
    }, 30_000);
  });
}

/** Re-render once a minute, for "locks itself in 14 minutes". */
export function useMinuteTick(): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return t;
}

export function vaultReady(overview: VaultOverview): boolean {
  return overview.myKey?.own != null;
}

/** The user name a password manager files the vault passphrase under (sign-off rua-ui-audit,
 * "vault entries"), so it is saved as an entry of its own and never offered as, or over, the Fathom
 * sign-in password. Bitwarden's own source (clients, main, read 2026-10-31,
 * overlay-notifications.background.ts) offers to add a login when a submitted form has a user name
 * and a password with values, and to change one on a matching user name and password pair; a
 * user name of its own makes this a different login. Visually hidden, not `hidden`, so it is still
 * read as a field. */
export function VaultPassphraseName() {
  const address = getSession()?.address ?? '';
  return (
    <input
      className="vh"
      type="text"
      name="username"
      autoComplete="username"
      value={address === '' ? 'Fathom vault passphrase' : `${address} (Fathom vault passphrase)`}
      readOnly
      tabIndex={-1}
      aria-hidden="true"
    />
  );
}
