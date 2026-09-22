import { useState, type FormEvent } from 'react';

import {
  confirmAppCode,
  enrolAppCode,
  registerBrowserKey,
  setPassword,
  type TotpEnrolment,
} from '../api/credentials';
import { ApiRefusal } from '../api/errors';
import { QrCode } from '../qr';
import { describeAppCodeRefusal } from './appCodeRefusal';
import '../styles/signin.css';
import '../styles/authenticator.css';

export interface AccountProps {
  /** Whose account this is — the address of the live session. Shown, and
   * used to file this browser's key once the authenticator app exists. */
  address: string;
  /** `'app-code'` when the server has just refused an ordinary route with
   * its `CredentialError::NoTotpEnrolled`: the account holds the operator
   * custody and its session may do nothing else until the second factor is
   * enrolled (ADR-0055 decision 10). `'settings'` is the ordinary screen a
   * signed-in person opens themselves.
   *
   * The name is the server's refusal, not a label anybody reads — ADR-0056
   * decision 4 renames what is shown, not what is routed. */
  purpose?: 'settings' | 'app-code';
  /** Called once the authenticator app is confirmed and its recovery codes
   * are saved, so the caller can leave this screen. */
  onDone?: () => void;
  /** A way back, for the person who opened this themselves. Absent on the
   * `'app-code'` purpose, where there is nowhere else to go until the second
   * factor is enrolled. */
  onClose?: () => void;
}

/**
 * The credential screen for whoever is signed in: set or change the password,
 * and set up the authenticator app.
 *
 * Both acts are `/credentials/*` routes, which is the one place a setup
 * session may reach — so this same screen serves the person the server has
 * just stopped for having no second factor and the person who came here on
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
            ? 'This account holds the operator custody, so it needs an authenticator app before anything else.'
            : `Your credentials, ${address}.`}
        </p>

        {purpose === 'settings' && <PasswordForm />}

        <AuthenticatorEnrolment address={address} onDone={() => onDone?.()} />

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

type EnrolmentStage =
  | { kind: 'idle' }
  | { kind: 'drawing' }
  | { kind: 'enrolled'; enrolment: TotpEnrolment }
  | { kind: 'confirming'; enrolment: TotpEnrolment }
  | { kind: 'recovery'; codes: string[] };

export interface AuthenticatorEnrolmentProps {
  address: string;
  onDone: () => void;
}

/**
 * Set up the authenticator app, in the three steps ADR-0056 decision 2 step 3
 * and decision 4 name: draw the secret and show it as a QR code with the
 * setup key beside it, prove a verification code made from it, then show the
 * ten recovery codes **once**.
 *
 * **The QR code is why this screen changed.** Bitwarden reads an
 * authenticator secret only by decoding a code out of a screenshot of the
 * visible tab; text and copy buttons are invisible to it (ADR-0056, *What was
 * looked at*). The previous screen had the secret as text alone, so a person
 * whose password manager holds their second factor could not enrol at all.
 * The code is drawn by `../qr`, in the page, so the
 * Content-Security-Policy does not move (decisions 5 and 7).
 *
 * The recovery codes are shown once because the server keeps only their
 * hashes (`credentials::backup_code_hash` — the column keeps its name,
 * decision 4); nothing here can fetch them again, so the step that dismisses
 * them asks the person to say they have them.
 */
export function AuthenticatorEnrolment({ address, onDone }: AuthenticatorEnrolmentProps) {
  const [stage, setStage] = useState<EnrolmentStage>({ kind: 'idle' });
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
      // ADR-0055 decision 10: an account that already has a second factor is
      // refused here, and the server's own sentence for that case is what
      // this screen shows (`./appCodeRefusal.ts`).
      setRefusal(describeAppCodeRefusal(error));
    }
  }

  async function confirm(event: FormEvent<HTMLFormElement>, enrolment: TotpEnrolment) {
    event.preventDefault();
    setRefusal(null);
    setStage({ kind: 'confirming', enrolment });
    try {
      const codes = await confirmAppCode(code);
      setCode('');
      // The second factor exists now, so a key for this browser can be
      // registered without turning the next setup session into a full one —
      // see `../api/auth.ts`'s note on why the order matters. Best effort: it
      // costs the next sign-in its `A1` and nothing else.
      await registerBrowserKey(address).catch(() => {});
      setStage({ kind: 'recovery', codes });
    } catch (error) {
      console.error(error);
      setStage({ kind: 'enrolled', enrolment });
      setRefusal(describeAppCodeRefusal(error));
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

  if (stage.kind === 'recovery') {
    return (
      <RecoveryCodesStage
        address={address}
        codes={stage.codes}
        saved={saved}
        onSavedChange={setSaved}
        onCopy={() => copy('recovery', recoveryCodeFile(address, stage.codes))}
        copied={copied === 'recovery'}
        onDownload={() => downloadRecoveryCodes(address, stage.codes)}
        onDone={() => {
          // **The flag does not outlive the screen.** It is the person's
          // answer about THESE ten codes; carrying it into a second
          // enrolment would arm the Done button before the second set had
          // been looked at.
          setSaved(false);
          setCopied(null);
          setStage({ kind: 'idle' });
          onDone();
        }}
      />
    );
  }

  if (stage.kind === 'enrolled' || stage.kind === 'confirming') {
    const { enrolment } = stage;
    return (
      <AuthenticatorSetupStage
        address={address}
        secretBase32={enrolment.secretBase32}
        otpauthUri={enrolment.otpauthUri}
        code={code}
        onCodeChange={setCode}
        onSubmit={(event) => confirm(event, enrolment)}
        refusal={refusal}
        busy={stage.kind === 'confirming'}
        onCopy={copy}
        copied={copied}
      />
    );
  }

  return (
    <div className="signin__section">
      <h2 className="signin__heading">Authenticator app</h2>
      <p className="signin__body">
        A six-digit verification code from an authenticator app, beside your password. It is required for an account
        that holds the operator custody. An account that already has one cannot replace it here: that is a recovery,
        and it goes through the host command, not a form.
      </p>
      <button
        className="signin__submit"
        type="button"
        onClick={draw}
        disabled={stage.kind === 'drawing'}
      >
        {stage.kind === 'drawing' ? 'Drawing a secret…' : 'Set up an authenticator app'}
      </button>
      {refusal && (
        <div className="signin__refusal" role="alert">
          {refusal}
        </div>
      )}
    </div>
  );
}

export interface AuthenticatorSetupStageProps {
  /** Whose account the code is for. Shown, so that a person with accounts on
   * more than one server knows which one they are about to bind a phone to. */
  address: string;
  /** The base32 secret, for typing in by hand — the **setup key**. */
  secretBase32: string;
  /** The same secret inside the `otpauth://` URI, which is what the QR code
   * says and what the password manager photographs. */
  otpauthUri: string;
  code: string;
  onCodeChange: (code: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /** A sentence to show, or `null`. Written by the caller; this component
   * does not interpret errors. */
  refusal: string | null;
  /** True while the code is with the server. */
  busy: boolean;
  onCopy?: (what: 'secret' | 'uri', text: string) => void;
  /** Which of the two copy buttons has just been pressed, if either. */
  copied?: string | null;
}

/**
 * Step 3 of ADR-0056 decision 2: the QR code, the setup key beside it, the
 * `otpauth://` link for whoever wants it, and one field.
 *
 * **Pure and prop-driven**, so a test can render it with fixture data. The
 * stateful `AuthenticatorEnrolment` above owns the enrolment the server drew
 * and passes its two strings in; this component holds nothing. That split is
 * the finding it closes: neither of the two screens ADR-0056 rewrote had a
 * test that rendered it, because rendering them meant spending a real
 * enrolment.
 */
export function AuthenticatorSetupStage({
  address,
  secretBase32,
  otpauthUri,
  code,
  onCodeChange,
  onSubmit,
  refusal,
  busy,
  onCopy,
  copied = null,
}: AuthenticatorSetupStageProps) {
  return (
    <form className="signin__section" onSubmit={onSubmit}>
      <h2 className="signin__heading">Set up your authenticator app</h2>
      <p className="signin__body">
        For {address}. Scan the code with your authenticator app, then type the six digits it shows.
      </p>

      <div className="authenticator__scan">
        <QrCode value={otpauthUri} label="The QR code for this account's authenticator app" />
        <p className="authenticator__scan-text">Scan this with your authenticator app.</p>
      </div>

      <p className="signin__label">Or enter this setup key</p>
      <p className="signin__mono signin__mono--wrap" data-testid="totp-secret">
        {secretBase32}
      </p>
      <button type="button" className="signin__switch" onClick={() => onCopy?.('secret', secretBase32)}>
        {copied === 'secret' ? 'Copied.' : 'Copy the setup key'}
      </button>

      {/* Closed by default. The URI holds the setup key, so it is one more
          place the secret is on screen; the person who wants it knows they
          want it. */}
      <details className="authenticator__reveal">
        <summary>Show the otpauth link</summary>
        <p className="signin__mono signin__mono--wrap" data-testid="totp-uri">
          {otpauthUri}
        </p>
        <button type="button" className="signin__switch" onClick={() => onCopy?.('uri', otpauthUri)}>
          {copied === 'uri' ? 'Copied.' : 'Copy the link'}
        </button>
      </details>

      <div className="signin__field">
        <label className="signin__label" htmlFor="account-code">
          Verification code
        </label>
        <input
          id="account-code"
          className="signin__input signin__input--mono"
          type="text"
          inputMode="numeric"
          // ADR-0056: Bitwarden finds this field by `autocomplete` first and
          // by keywords second (`inline-menu-field-qualification.service.ts`).
          autoComplete="one-time-code"
          spellCheck={false}
          value={code}
          onChange={(event) => onCodeChange(event.target.value)}
          disabled={busy}
          required
        />
        <p className="signin__hint">Enter the six digits the app shows to confirm it is set up.</p>
      </div>
      <button className="signin__submit" type="submit" disabled={busy || code.trim().length === 0}>
        {busy ? 'Checking…' : 'Confirm'}
      </button>
      {refusal && (
        <div className="signin__refusal" role="alert">
          {refusal}
        </div>
      )}
    </form>
  );
}

export interface RecoveryCodesStageProps {
  /** The account the codes open. In the file and on the screen, because ten
   * codes with no server named beside them are ten codes nobody dares
   * delete. */
  address: string;
  codes: readonly string[];
  /** The person's answer to "I have saved these". Held by the caller, so the
   * caller can clear it when this screen is left. */
  saved: boolean;
  onSavedChange: (saved: boolean) => void;
  onDone: () => void;
  onCopy?: () => void;
  copied?: boolean;
  onDownload?: () => void;
}

/**
 * Step 4 of ADR-0056 decision 2: the ten recovery codes, shown **once**.
 *
 * The server keeps only their hashes, so nothing can fetch them again; that
 * is why leaving this screen is gated on the person saying they have them,
 * and why the gate is a control they have to press rather than a sentence
 * they can scroll past.
 */
export function RecoveryCodesStage({
  address,
  codes,
  saved,
  onSavedChange,
  onDone,
  onCopy,
  copied = false,
  onDownload,
}: RecoveryCodesStageProps) {
  return (
    <div className="signin__section">
      <h2 className="signin__heading">Save your recovery codes</h2>
      <p className="signin__body">
        Each of these works once, and stands in for the phone: if you cannot reach your authenticator app, type one
        of them where the verification code goes. They are shown now and never again — the server keeps only their
        hashes. They open {address}.
      </p>
      <ul className="authenticator__codes">
        {codes.map((recovery) => (
          <li key={recovery} className="authenticator__code">
            {recovery}
          </li>
        ))}
      </ul>
      <div className="authenticator__row">
        <button type="button" className="signin__switch" onClick={() => onCopy?.()}>
          {copied ? 'Copied.' : 'Copy all'}
        </button>
        <button type="button" className="signin__switch" onClick={() => onDownload?.()}>
          Download as text file
        </button>
      </div>
      {/* A button carrying the checkbox role, not an `<input type=checkbox>`:
          `design/tokens.css` sets `appearance: none` on every input, which
          leaves a native checkbox with nothing to draw. `aria-checked` is
          what a screen reader reads, and it is the same control. */}
      <button
        type="button"
        role="checkbox"
        aria-checked={saved}
        className={saved ? 'signin__toggle signin__toggle--on' : 'signin__toggle'}
        onClick={() => onSavedChange(!saved)}
      >
        <span className="signin__toggle-box" aria-hidden="true">
          {saved ? '✓' : ''}
        </span>
        <span>I have saved these.</span>
      </button>
      <button className="signin__submit" type="button" disabled={!saved} onClick={onDone}>
        Done
      </button>
    </div>
  );
}

/**
 * `AuthenticatorEnrolment` under its old name.
 *
 * @deprecated ADR-0056 decision 4 renamed this. The alias is here so the
 * first-run stream's screens keep building while both halves land; delete it
 * once nothing imports it.
 */
export const AppCodeEnrolment = AuthenticatorEnrolment;

/**
 * What the downloaded file and the "Copy all" button both say.
 *
 * The address is in it because a person may hold accounts on more than one
 * Fathom, and ten codes in a text file with nothing to say which server they
 * open are ten codes nobody will dare delete. The secret is **not** in it:
 * these are the codes, not the setup key.
 */
export function recoveryCodeFile(address: string, codes: readonly string[]): string {
  return [
    `Fathom recovery codes for ${address}`,
    'Each code works once, and stands in for your authenticator app.',
    '',
    ...codes,
    '',
  ].join('\n');
}

/** Save the recovery codes as a file, from this browser, with no server round
 * trip: the codes are already on the page and asking for them again would be
 * a second chance to lose them. */
function downloadRecoveryCodes(address: string, codes: readonly string[]): void {
  const blob = new Blob([recoveryCodeFile(address, codes)], { type: 'text/plain;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = 'fathom-recovery-codes.txt';
  document.body.append(link);
  link.click();
  link.remove();
  // **Revoked later, not on the next line.** `click()` only starts the
  // download; a browser that has not yet read the blob when the URL is
  // revoked saves an empty file, and the codes are on screen once. A few
  // seconds is long past the read and long before the tab is closed.
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
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
