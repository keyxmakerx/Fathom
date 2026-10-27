// The unlock (mockup r32-vault-unlock): one passphrase day to day; the Emergency Kit's vault key
// once on a new browser. "Forgot the passphrase?" says plainly what can and cannot come back.

import { useState } from 'react';

import type { VaultOverview } from '../../api/vault';
import { WrongSecret } from '../../vault/crypto';
import { UNLOCK_MINUTES, rememberedKit, unlockVault, vaultEngine } from '../../vault/session';
import { describeError } from '../design/useDesignSession';
import { VaultModal } from './Modal';

export function UnlockDialog({ organisation, overview, onDone, onClose }: { organisation: string; overview: VaultOverview; onDone: () => void; onClose: () => void }) {
  const remembered = rememberedKit(organisation, overview.me) != null;
  const [passphrase, setPassphrase] = useState('');
  const [kit, setKit] = useState('');
  const [useKit, setUseKit] = useState(!remembered);
  const [forgot, setForgot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await unlockVault(await vaultEngine(), overview, organisation, passphrase, useKit ? kit : undefined);
      onDone();
    } catch (e) {
      setError(e instanceof WrongSecret ? e.message : describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <VaultModal title="Unlock your vault" onClose={onClose} testId="vault-unlock">
      <p className="vault-muted">
        {remembered && !useKit
          ? 'This browser remembers your vault key, so only your passphrase is needed.'
          : 'This browser does not have your vault key yet. Type it from your Emergency Kit once, then just the passphrase.'}
      </p>
      <form
        className="vault-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void submit();
        }}
      >
        {useKit && (
          <label className="vault-field">
            <span className="vault-field__label">Vault key, from your Emergency Kit</span>
            <input className="vault-input vault-input--mono" value={kit} onChange={(e) => setKit(e.target.value)} autoComplete="off" spellCheck={false} placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX" data-testid="vault-kit" />
          </label>
        )}
        <label className="vault-field">
          <span className="vault-field__label">Vault passphrase</span>
          <input className="vault-input" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="current-password" data-testid="vault-passphrase" />
        </label>
        <p className="vault-small">Stays unlocked for {UNLOCK_MINUTES} minutes in this tab after you last use it. Lock it sooner from your avatar.</p>
        {error && (
          <p className="vault-error" role="alert">
            {error}
          </p>
        )}
        <div className="vault-actions">
          <button type="submit" className="vault-btn btn-main" disabled={busy || passphrase.length === 0 || (useKit && kit.trim() === '')} data-testid="vault-unlock-go">
            {busy ? 'Unlocking…' : 'Unlock'}
          </button>
          <button type="button" className="vault-btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
      <div className="vault-foot">
        {remembered && !useKit && (
          <p>
            New computer?{' '}
            <button type="button" className="vault-link" onClick={() => setUseKit(true)}>
              Use your Emergency Kit
            </button>{' '}
            — you type the vault key once, then just the passphrase.
          </p>
        )}
        <p>
          <button type="button" className="vault-link" onClick={() => setForgot(!forgot)} aria-expanded={forgot}>
            Forgot the passphrase?
          </button>
        </p>
        {forgot && (
          <div className="vault-note" data-testid="vault-forgot">
            <p>
              <strong>Your passphrase cannot be recovered</strong>, by anyone at Fathom or in your organisation. That is what makes a
              stolen database useless.
            </p>
            <p>
              What comes back: every login that was also shared with a colleague or the organisation's recovery sheet. Set up the vault
              again from <em>Emergency Kit and passphrase</em> in your avatar menu, then ask a colleague who holds them, or an admin
              with the recovery sheet, to share them with you again.
            </p>
            <p>What does not: a login you kept only for yourself.</p>
          </div>
        )}
      </div>
    </VaultModal>
  );
}
