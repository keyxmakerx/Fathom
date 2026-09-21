import { useState, type FormEvent } from 'react';

import {
  confirmAppCode,
  enrolAppCode,
  registerBrowserKey,
  setPassword,
  type TotpEnrolment,
} from '../api/credentials';
import { ApiRefusal } from '../api/errors';
import '../styles/signin.css';

export interface AccountProps {
  /** Whose account this is — the address of the live session. Shown, and
   * used to file this browser's key once the app code exists. */
  address: string;
  /** `'app-code'` when the server has just refused an ordinary route with
   * *"enrol an app code first"*: the account holds the operator custody and
   * its session may do nothing else until the code is enrolled (ADR-0055
   * decision 10). `'settings'` is the ordinary screen a signed-in person
   * opens themselves. */
  purpose?: 'settings' | 'app-code';
  /** Called once the app code is confirmed and its backup codes are saved,
   * so the caller can leave this screen. */
  onDone?: () => void;
  /** A way back, for the person who opened this themselves. Absent on the
   * `'app-code'` purpose, where there is nowhere else to go until the code
   * is enrolled. */
  onClose?: () => void;
}

/**
 * The credential screen for whoever is signed in: set or change the password,
 * and enrol the app code.
 *
 * Both acts are `/credentials/*` routes, which is the one place a setup
 * session may reach — so this same screen serves the person who has just been
 * stopped by *"enrol an app code first"* and the person who came here on
 * purpose. What changes between them is the sentence at the top and whether
 * there is a way out; the controls are the same controls.
 *
 * **No old-password field.** The server's `POST /credentials/password` takes
 * one field, the new password, and the session's own signature is what proves
 * the right to change it (`api.rs`'s `set_password_handler`). A second field
 * this client collected and did not send would be theatre.
 */
export function Account({ address, purpose = 'settings', onDone, onClose }: AccountProps) {
  return (
    <div className="signin">
      <div className="signin__card">
        <h1 className="signin__title">Fathom</h1>
        <p className="signin__subtitle">
          {purpose === 'app-code'
            ? 'This account holds the operator custody, so it needs an app code before anything else.'
            : `Your credentials, ${address}.`}
        </p>

        {purpose === 'settings' && <PasswordForm />}

        <AppCodeEnrolment address={address} onDone={onDone} />

        {purpose === 'settings' && onClose && (
          <button type="button" className="signin__switch" onClick={onClose}>
            Back
          </button>
        )}
      </div>
    </div>
  );
}

/** Set or change the password. `POST /credentials/password`, `LP(password)`. */
export function PasswordForm() {
  const [chosen, setChosen] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRefusal(null);
    setDone(false);
    if (chosen !== again) {
      // Checked here because the two fields exist here; every rule about
      // what a password may BE is the server's (`credentials.rs`'s policy,
      // whose refusals explain themselves and are shown verbatim below).
      setRefusal('The two passwords are not the same.');
      return;
    }
    setBusy(true);
    try {
      await setPassword(chosen);
      setChosen('');
      setAgain('');
      setDone(true);
    } catch (error) {
      console.error(error);
      setRefusal(describe(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="signin__section" onSubmit={handleSubmit}>
      <h2 className="signin__heading">Password</h2>
      <div className="signin__field">
        <label className="signin__label" htmlFor="account-password">
          New password
        </label>
        <input
          id="account-password"
          className="signin__input"
          type="password"
          autoComplete="new-password"
          value={chosen}
          onChange={(event) => setChosen(event.target.value)}
          disabled={busy}
          required
        />
        <p className="signin__hint">
          At least fifteen characters. No composition rules and no expiry: length is the whole of the requirement.
        </p>
      </div>
      <div className="signin__field">
        <label className="signin__label" htmlFor="account-password-again">
          Again
        </label>
        <input
          id="account-password-again"
          className="signin__input"
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={(event) => setAgain(event.target.value)}
          disabled={busy}
          required
        />
      </div>
      <button className="signin__submit" type="submit" disabled={busy || chosen.length === 0}>
        {busy ? 'Setting…' : 'Set password'}
      </button>
      {done && <p className="signin__note">Password set. Every other session of this account has ended.</p>}
      {refusal && (
        <div className="signin__refusal" role="alert">
          {refusal}
        </div>
      )}
    </form>
  );
}

type CodeStage =
  | { kind: 'idle' }
  | { kind: 'drawing' }
  | { kind: 'enrolled'; enrolment: TotpEnrolment }
  | { kind: 'confirming'; enrolment: TotpEnrolment }
  | { kind: 'backup'; codes: string[] };

export interface AppCodeEnrolmentProps {
  address: string;
  onDone?: () => void;
}

/**
 * Enrol the app code, in the three steps ADR-0055 decision 10 names: draw the
 * secret, prove a code made from it, then show the ten backup codes **once**.
 *
 * The secret and its `otpauth://` URI are shown as text. A QR code needs an
 * encoder this client does not import (OPEN-QUESTIONS A3, and no new package
 * is in this stream's budget), and the ADR says so in the same words.
 *
 * The backup codes are shown once because the server keeps only their hashes
 * (`credentials::backup_code_hash`); nothing here can fetch them again, so
 * the step that dismisses them asks the person to say they have them.
 */
export function AppCodeEnrolment({ address, onDone }: AppCodeEnrolmentProps) {
  const [stage, setStage] = useState<CodeStage>({ kind: 'idle' });
  const [code, setCode] = useState('');
  const [saved, setSaved] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function draw() {
    setRefusal(null);
    setStage({ kind: 'drawing' });
    try {
      setStage({ kind: 'enrolled', enrolment: await enrolAppCode() });
    } catch (error) {
      console.error(error);
      setStage({ kind: 'idle' });
      setRefusal(describe(error));
    }
  }

  async function confirm(event: FormEvent<HTMLFormElement>, enrolment: TotpEnrolment) {
    event.preventDefault();
    setRefusal(null);
    setStage({ kind: 'confirming', enrolment });
    try {
      const codes = await confirmAppCode(code);
      setCode('');
      // The app code exists now, so a key for this browser can be registered
      // without turning the next setup session into a full one — see
      // `../api/auth.ts`'s note on why the order matters. Best effort: it
      // costs the next sign-in its `A1` and nothing else.
      await registerBrowserKey(address).catch(() => {});
      setStage({ kind: 'backup', codes });
    } catch (error) {
      console.error(error);
      setStage({ kind: 'enrolled', enrolment });
      setRefusal(describe(error));
    }
  }

  async function copy(what: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      // A browser that refuses the clipboard is not an error state: the
      // value is on the screen as text and can be selected by hand.
      setCopied(null);
    }
  }

  if (stage.kind === 'backup') {
    return (
      <div className="signin__section">
        <h2 className="signin__heading">Your backup codes</h2>
        <p className="signin__body">
          Ten codes, each good once, for the day the phone is not to hand. They are shown now and never again — the
          server keeps only their hashes. Write them down or put them where you keep your other secrets.
        </p>
        <ul className="signin__codes">
          {stage.codes.map((backup) => (
            <li key={backup} className="signin__code">
              {backup}
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="signin__switch"
          onClick={() => copy('backup', stage.codes.join('\n'))}
        >
          {copied === 'backup' ? 'Copied.' : 'Copy all ten'}
        </button>
        {/* A pressed button, not a checkbox: `design/tokens.css` sets
            `appearance: none` on every input, which leaves a native
            checkbox with nothing to draw. The state is carried by
            `aria-pressed`, which is what a screen reader reads. */}
        <button
          type="button"
          className={saved ? 'signin__toggle signin__toggle--on' : 'signin__toggle'}
          aria-pressed={saved}
          onClick={() => setSaved((was) => !was)}
        >
          <span className="signin__toggle-box" aria-hidden="true">
            {saved ? '✓' : ''}
          </span>
          <span>I have saved these.</span>
        </button>
        <button
          className="signin__submit"
          type="button"
          disabled={!saved}
          onClick={() => {
            setStage({ kind: 'idle' });
            onDone?.();
          }}
        >
          Continue
        </button>
      </div>
    );
  }

  if (stage.kind === 'enrolled' || stage.kind === 'confirming') {
    const { enrolment } = stage;
    return (
      <form className="signin__section" onSubmit={(event) => confirm(event, enrolment)}>
        <h2 className="signin__heading">Enrol your app code</h2>
        <p className="signin__body">
          Put this secret into your authenticator app, then type the six digits it shows.
        </p>
        <p className="signin__label">Secret</p>
        <p className="signin__mono" data-testid="totp-secret">
          {enrolment.secretBase32}
        </p>
        <button type="button" className="signin__switch" onClick={() => copy('secret', enrolment.secretBase32)}>
          {copied === 'secret' ? 'Copied.' : 'Copy the secret'}
        </button>
        <p className="signin__label">Or the whole URI</p>
        <p className="signin__mono signin__mono--wrap" data-testid="totp-uri">
          {enrolment.otpauthUri}
        </p>
        <button type="button" className="signin__switch" onClick={() => copy('uri', enrolment.otpauthUri)}>
          {copied === 'uri' ? 'Copied.' : 'Copy the URI'}
        </button>
        <div className="signin__field">
          <label className="signin__label" htmlFor="account-code">
            The six digits
          </label>
          <input
            id="account-code"
            className="signin__input signin__input--mono"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            spellCheck={false}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            disabled={stage.kind === 'confirming'}
            required
          />
        </div>
        <button
          className="signin__submit"
          type="submit"
          disabled={stage.kind === 'confirming' || code.trim().length === 0}
        >
          {stage.kind === 'confirming' ? 'Checking…' : 'Confirm the code'}
        </button>
        {refusal && (
          <div className="signin__refusal" role="alert">
            {refusal}
          </div>
        )}
      </form>
    );
  }

  return (
    <div className="signin__section">
      <h2 className="signin__heading">App code</h2>
      <p className="signin__body">
        A six-digit code from an authenticator app, beside your password. It is required for an account that holds
        the operator custody. An account that already has one cannot replace it here: that is a recovery, and it
        goes through the host command, not a form.
      </p>
      <button
        className="signin__submit"
        type="button"
        onClick={draw}
        disabled={stage.kind === 'drawing'}
      >
        {stage.kind === 'drawing' ? 'Drawing a secret…' : 'Enrol an app code'}
      </button>
      {refusal && (
        <div className="signin__refusal" role="alert">
          {refusal}
        </div>
      )}
    </div>
  );
}

/** The server's own sentence, verbatim, or this screen's honest "it did not
 * complete". The password policy is the one refusal that explains itself
 * (`api.rs`'s `CredentialRefusal`); everything else is uniform on purpose and
 * is not interpreted here. */
export function describe(error: unknown): string {
  if (error instanceof ApiRefusal) {
    return error.retryAfterSeconds != null
      ? `${error.message} Try again in ${error.retryAfterSeconds}s.`
      : error.message;
  }
  return 'That did not complete. See the console for detail.';
}
