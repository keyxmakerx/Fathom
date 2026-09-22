import { useState, type FormEvent } from 'react';

import { signIn } from '../api/auth';
import { PRINCIPAL_KIND_STEWARD } from '../api/constants';
import { redeemOperatorSetup } from '../api/credentials';
import { MalformedTokenError, parseToken } from '../api/enrolment';
import { ApiRefusal } from '../api/errors';
import { AppCodeEnrolment, describe } from './Account';
import '../styles/signin.css';

export interface SetupProps {
  /** Back to the ordinary door. */
  onUseSignIn?: () => void;
  /**
   * Setup is finished: the password is set, the app code is enrolled and the
   * backup codes are saved.
   *
   * **The session made along the way does not carry on.** It was minted
   * before the app code existed, so its `assurance` is `A0` — the setup
   * session — and `operators::register_own_operator_key` refuses `A0`
   * outright, whatever the account has enrolled since. A session's assurance
   * is what it was proved with at the time, and no later act upgrades the
   * row. So the way to the console is a fresh sign-in with both factors, and
   * the caller ends this one and says so.
   */
  onDone?: (address: string) => void;
}

type Stage =
  | { kind: 'form' }
  | { kind: 'setting' }
  | { kind: 'signing-in' }
  | { kind: 'app-code'; address: string };

/**
 * The first operator's setup door, for the token the server writes at its
 * first start (`op_…`, `FATHOM_BOOTSTRAP_TOKEN_FILE`).
 *
 * ADR-0055 decision 10: *"the token file the first start writes opens a setup
 * screen (set the password, enrol the app code, save the backup codes)
 * instead of enrolling a browser key"*. In order:
 *
 * 1. `POST /enrolment/operator/setup`, `LP(token) ‖ LP(password)`. It spends
 *    the token and answers nothing — the lead's resolution 4, so that a token
 *    can never become a session without the password being checked.
 * 2. `POST /session` with the address and that password. The account holds
 *    the operator custody and has no app code yet, so what comes back is a
 *    **setup session**: good for `/credentials/*` and refused everywhere
 *    else.
 * 3. The app code, and the ten backup codes, through the same component the
 *    account screen uses.
 *
 * **The address is asked for.** The token file does not carry it; it is the
 * address in `FATHOM_OPERATOR_NOTICE_ADDRESS` that the first start made the
 * account for, and the person holding the token file is the person who set
 * that variable. Guessing it here would be this client inventing an identity.
 *
 * The token is held in this component's own state only — never a URL, a query
 * string, a log line or `localStorage` — and cleared the moment the server
 * confirms it is spent, exactly as `Enrol.tsx` handles an invitation.
 */
/** What a refused redemption says here. The server answers one sentence for
 * every cause, for the audit trail; this lists the causes for the person and
 * says what to do about each, without guessing which one it was. */
const SETUP_REFUSED =
  'Refused. Either this is not the current token (the file is rewritten at every first start and upgrade, so ' +
  'copy it out again after the latest restart), or it has expired, or the address is not the one the server was ' +
  'started with. A fresh code: fathom-server recover-operator <address>, run on the host.';

export function Setup({ onUseSignIn, onDone }: SetupProps) {
  const [token, setToken] = useState('');
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [stage, setStage] = useState<Stage>({ kind: 'form' });
  const [refusal, setRefusal] = useState<string | null>(null);

  const busy = stage.kind === 'setting' || stage.kind === 'signing-in';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRefusal(null);

    let parsed: ReturnType<typeof parseToken>;
    try {
      parsed = parseToken(token);
    } catch (error) {
      setRefusal(error instanceof MalformedTokenError ? error.message : 'That token could not be read.');
      return;
    }
    if (parsed.kind === 'steward' || parsed.kind === 'organisation') {
      setRefusal('That is not the token the server wrote at first start. An invitation is redeemed at the other door.');
      return;
    }
    if (password !== again) {
      setRefusal('The two passwords are not the same.');
      return;
    }

    setStage({ kind: 'setting' });
    try {
      await redeemOperatorSetup(parsed.bytes, password);
    } catch (error) {
      console.error(error);
      // Nothing about the token has changed unless the server said it spent
      // it, and it says that by answering. A refusal leaves the field as
      // typed, the same reading `Enrol.tsx` makes.
      setStage({ kind: 'form' });
      setRefusal(error instanceof ApiRefusal && error.retryAfterSeconds == null ? SETUP_REFUSED : describe(error));
      return;
    }
    // Confirmed spent: nothing on this screen may suggest sending it again.
    setToken('');

    const chosen = address.trim();
    setStage({ kind: 'signing-in' });
    try {
      // **No browser key yet.** The app code does not exist, so a key here
      // would make the next session `A1` and slip past the very gate that
      // keeps an unfinished operator on this screen — see `../api/auth.ts`.
      await signIn(chosen, PRINCIPAL_KIND_STEWARD, { password, registerBrowserKey: false });
    } catch (error) {
      console.error(error);
      setStage({ kind: 'form' });
      setRefusal(
        `${describe(error)} The password is set; sign in with it at the ordinary door.`,
      );
      return;
    }
    setPassword('');
    setAgain('');
    setStage({ kind: 'app-code', address: chosen });
  }

  if (stage.kind === 'app-code') {
    return (
      <div className="signin">
        <div className="signin__card">
          <h1 className="signin__title">Fathom</h1>
          <p className="signin__subtitle">
            Password set for {stage.address}. One more step: this account holds the operator custody, so it needs an
            app code before it can do anything else. When it has one you sign in again, with both.
          </p>
          <AppCodeEnrolment address={stage.address} onDone={() => onDone?.(stage.address)} />
        </div>
      </div>
    );
  }

  return (
    <div className="signin">
      <form className="signin__card" onSubmit={handleSubmit}>
        <h1 className="signin__title">Fathom</h1>
        <p className="signin__subtitle">
          Set up the first operator. You need the token line from the file the server wrote at its first start, or
          the code that <code>fathom-server recover-operator</code> printed.
        </p>

        <div className="signin__field">
          <label className="signin__label" htmlFor="setup-token">
            Setup token
          </label>
          <input
            id="setup-token"
            className="signin__input signin__input--mono"
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            disabled={busy}
            required
          />
          <p className="signin__hint">
            The whole line, beginning <code>op_</code>, from the file named in the server&apos;s FIRST START or
            UPGRADE log line. Copy it out with <code>docker compose cp</code>; <code>docs/RUNNING-IT.md</code> shows
            the command. Every restart that writes that file replaces the old one, so copy it again after the latest
            restart.
          </p>
        </div>

        <div className="signin__field">
          <label className="signin__label" htmlFor="setup-address">
            Address
          </label>
          <input
            id="setup-address"
            className="signin__input"
            type="text"
            autoComplete="username"
            spellCheck={false}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            disabled={busy}
            required
          />
          <p className="signin__hint">
            The address in <code>FATHOM_OPERATOR_NOTICE_ADDRESS</code>, typed exactly as it is there. The server made
            this account for it at first start and bound the operator custody to it.
          </p>
        </div>

        <div className="signin__field">
          <label className="signin__label" htmlFor="setup-password">
            Choose a password
          </label>
          <input
            id="setup-password"
            className="signin__input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
            required
          />
          <p className="signin__hint">
            At least fifteen characters. No composition rules and no expiry: length is the whole of the requirement.
          </p>
        </div>

        <div className="signin__field">
          <label className="signin__label" htmlFor="setup-password-again">
            Again
          </label>
          <input
            id="setup-password-again"
            className="signin__input"
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(event) => setAgain(event.target.value)}
            disabled={busy}
            required
          />
        </div>

        <button
          className="signin__submit"
          type="submit"
          disabled={busy || token.trim().length === 0 || address.trim().length === 0}
        >
          {stage.kind === 'setting' ? 'Setting the password…' : stage.kind === 'signing-in' ? 'Signing in…' : 'Set up'}
        </button>

        {refusal && (
          <div className="signin__refusal" role="alert">
            {refusal}
          </div>
        )}

        <p className="signin__note">
          The token works once. After this, you sign in with the address, the password and the app code.
        </p>

        {onUseSignIn && (
          <button type="button" className="signin__switch" onClick={onUseSignIn}>
            Already set up? Sign in.
          </button>
        )}
      </form>
    </div>
  );
}
