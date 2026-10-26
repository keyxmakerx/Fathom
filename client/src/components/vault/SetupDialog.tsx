// Setting up (mockup r32-vault-lockout-a): the Emergency Kit is saved BEFORE the passphrase is
// chosen, so nobody finishes setup holding a vault they cannot open on their next computer.

import { useEffect, useMemo, useState } from 'react';

import { signingKey } from '../../api/share';
import type { VaultOverview } from '../../api/vault';
import { newVaultSecret, vaultKeyText } from '../../vault/crypto';
import { setUpVault, vaultEngine } from '../../vault/session';
import { describeError } from '../design/useDesignSession';
import { VaultModal } from './Modal';
import { KitSheet, rememberCheck } from './parts';

export const MIN_PASSPHRASE = 12;

export function SetupDialog({ organisation, organisationName, overview, onDone, onClose }: { organisation: string; organisationName: string; overview: VaultOverview; onDone: () => void; onClose: () => void }) {
  const replacing = overview.myKey != null;
  const [step, setStep] = useState(1);
  const secret = useMemo(() => newVaultSecret(), []);
  const kit = vaultKeyText(secret);
  const [saved, setSaved] = useState(false);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The vault key is signed by this browser's own key, which is made at a sign-in with the
  // authenticator app (ADR-0056 decision 4 words it that way, never "app code").
  // Someone who signed in with only a password is told so before the kit, not after the passphrase.
  const [noKeyHere, setNoKeyHere] = useState(false);
  useEffect(() => {
    let live = true;
    signingKey().catch(() => live && setNoKeyHere(true));
    return () => {
      live = false;
    };
  }, []);

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      await setUpVault(await vaultEngine(), overview, organisation, a, secret);
      rememberCheck(organisation, overview.me);
      setStep(4);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const tooShort = a.length > 0 && a.length < MIN_PASSPHRASE;
  const differ = b.length > 0 && a !== b;

  return (
    <VaultModal title={replacing ? 'Set up your vault again' : 'Set up your vault'} onClose={onClose} wide testId="vault-setup">
      <p className="vault-step">Step {step} of 4</p>
      {step === 1 && (
        <>
          <p>
            Your vault keeps device logins for <strong>{organisationName}</strong>. Each one is locked in this browser before it is sent,
            with a key made from two things: a <strong>vault key</strong> Fathom shows you once, on your Emergency Kit, and a{' '}
            <strong>passphrase</strong> you choose.
          </p>
          {replacing && (
            <p className="vault-note vault-note--caution">
              This replaces your current vault key. Logins shared only with your old key cannot be opened by the new one: whoever else
              holds them, or an admin with the recovery sheet, shares them with you again.
            </p>
          )}
          {noKeyHere && (
            <p className="vault-note vault-note--caution" data-testid="vault-no-key-here">
              Your vault needs this browser&rsquo;s own signing key, which Fathom makes when you sign in with your authenticator app.
              Set up an authenticator app under Account, then sign out and sign in here again.
            </p>
          )}
          <div className="vault-actions">
            <button type="button" className="vault-btn vault-btn--solid" onClick={() => setStep(2)} disabled={noKeyHere} data-testid="vault-setup-next">
              Continue
            </button>
            <button type="button" className="vault-btn" onClick={onClose}>
              Not now
            </button>
          </div>
        </>
      )}
      {step === 2 && (
        <>
          <h3 className="vault-h3">Save your Emergency Kit</h3>
          <p>
            Your vault opens with this key <strong>and</strong> your passphrase together. This browser will remember the key; a new
            computer asks for it once. Fathom shows it only now.
          </p>
          <KitSheet kind="kit" organisationName={organisationName} code={kit} />
          <p className="vault-small">Keep it where you keep other important passwords: your own password manager, or printed in a drawer. Not in an email to yourself.</p>
          <label className="vault-check">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} data-testid="vault-kit-saved" /> I have saved my Emergency Kit
          </label>
          <div className="vault-actions">
            <button type="button" className="vault-btn vault-btn--solid" disabled={!saved} onClick={() => setStep(3)} data-testid="vault-setup-next">
              Continue
            </button>
            <button type="button" className="vault-btn" onClick={() => setStep(1)}>
              Back
            </button>
          </div>
        </>
      )}
      {step === 3 && (
        <form
          className="vault-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && a.length >= MIN_PASSPHRASE && a === b) void finish();
          }}
        >
          <h3 className="vault-h3">Choose your passphrase</h3>
          <p>
            At least {MIN_PASSPHRASE} characters. A few unrelated words is easier to type than a short tangle and harder to guess. Use
            one you use nowhere else, not your Fathom sign-in password.
          </p>
          <label className="vault-field">
            <span className="vault-field__label">Passphrase</span>
            <input className="vault-input" type="password" value={a} onChange={(e) => setA(e.target.value)} autoComplete="new-password" data-testid="vault-new-passphrase" />
          </label>
          {tooShort && <p className="vault-small">{MIN_PASSPHRASE - a.length} more characters.</p>}
          <label className="vault-field">
            <span className="vault-field__label">The same again</span>
            <input className="vault-input" type="password" value={b} onChange={(e) => setB(e.target.value)} autoComplete="new-password" data-testid="vault-new-passphrase-again" />
          </label>
          {differ && <p className="vault-small">The two are not the same yet.</p>}
          {error && (
            <p className="vault-error" role="alert">
              {error}
            </p>
          )}
          <div className="vault-actions">
            <button type="submit" className="vault-btn vault-btn--solid" disabled={busy || a.length < MIN_PASSPHRASE || a !== b} data-testid="vault-setup-finish">
              {busy ? 'Locking your vault key…' : 'Set up my vault'}
            </button>
            <button type="button" className="vault-btn" onClick={() => setStep(2)} disabled={busy}>
              Back
            </button>
          </div>
        </form>
      )}
      {step === 4 && (
        <>
          <h3 className="vault-h3">Your vault is ready, and unlocked</h3>
          <p>In three days Fathom will ask you to type your passphrase once, to check you still have it while forgetting it costs nothing.</p>
          <div className="vault-actions">
            <button
              type="button"
              className="vault-btn vault-btn--solid"
              onClick={() => {
                onDone();
              }}
              data-testid="vault-setup-done"
            >
              Done
            </button>
          </div>
        </>
      )}
    </VaultModal>
  );
}
