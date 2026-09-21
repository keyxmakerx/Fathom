import { useState, type FormEvent } from 'react';

import { redeemReset, requestReset } from '../api/credentials';
import { MalformedTokenError, parseToken } from '../api/enrolment';
import { describe } from './Account';
import '../styles/signin.css';

/**
 * The one sentence a forgotten password is answered with, whatever was typed.
 *
 * ADR-0055 decision 7 and the server's own `request_reset_handler`: the route
 * answers **200 for every address**, known or not, so this screen must say
 * the same thing for every address too. A screen that said "sent" for one
 * address and "no such account" for another would undo the route's whole
 * point.
 *
 * It also says plainly that mail is not set up yet, because on this build it
 * is not: no SMTP client exists (ADR-0055 cost/order item 5), so nothing is
 * actually sent, and a screen that implied otherwise would leave a person
 * waiting for a message that is not coming.
 */
export const RESET_ANSWER =
  'If that address has an account, a reset link goes to the address of record — once this site’s mail is set ' +
  'up in the console. Nothing is sent before then, and this answer is the same whatever was typed.';

export interface ResetProps {
  /** Back to the ordinary door. */
  onUseSignIn?: (address?: string, notice?: string) => void;
  /** A token this client already has — read from the link the person
   * followed (`tokenFromLocation`). When present the screen opens at the
   * second step. */
  initialToken?: string;
}

type Stage =
  | { kind: 'ask' }
  | { kind: 'asking' }
  | { kind: 'asked' }
  | { kind: 'redeem' }
  | { kind: 'redeeming' };

/**
 * Forgot my password, and the screen the link lands on.
 *
 * Two steps, one screen, because they are two halves of one act and a person
 * arriving by link has no use for the first. Neither step signs anybody in:
 * decision 7's *"no automatic sign-in"*, and *"it never skips the app
 * code"* — after a reset the person signs in with the new password **and**
 * their app code, at the ordinary door.
 */
export function Reset({ onUseSignIn, initialToken }: ResetProps) {
  const [address, setAddress] = useState('');
  const [token, setToken] = useState(initialToken ?? '');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [stage, setStage] = useState<Stage>(initialToken ? { kind: 'redeem' } : { kind: 'ask' });
  const [refusal, setRefusal] = useState<string | null>(null);

  async function handleAsk(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRefusal(null);
    setStage({ kind: 'asking' });
    try {
      await requestReset(address.trim());
    } catch (error) {
      // The only refusal this route gives is a rate limit, which answers the
      // same way for every address. Shown verbatim; it is not a statement
      // about whether the account exists.
      console.error(error);
      setStage({ kind: 'ask' });
      setRefusal(describe(error));
      return;
    }
    setStage({ kind: 'asked' });
  }

  async function handleRedeem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRefusal(null);

    let parsed: ReturnType<typeof parseToken>;
    try {
      parsed = parseToken(token);
    } catch (error) {
      setRefusal(error instanceof MalformedTokenError ? error.message : 'That link could not be read.');
      return;
    }
    if (password !== again) {
      setRefusal('The two passwords are not the same.');
      return;
    }

    setStage({ kind: 'redeeming' });
    try {
      await redeemReset(parsed.bytes, password);
    } catch (error) {
      console.error(error);
      setStage({ kind: 'redeem' });
      setRefusal(describe(error));
      return;
    }
    setToken('');
    setPassword('');
    setAgain('');
    onUseSignIn?.(
      address.trim() || undefined,
      'Password set. Sign in with it and your app code — a reset never skips the app code.',
    );
  }

  if (stage.kind === 'asked') {
    return (
      <div className="signin">
        <div className="signin__card">
          <h1 className="signin__title">Fathom</h1>
          <p className="signin__subtitle">Asked.</p>
          <p className="signin__body">{RESET_ANSWER}</p>
          <button type="button" className="signin__submit" onClick={() => onUseSignIn?.()}>
            Back to sign-in
          </button>
          <button type="button" className="signin__switch" onClick={() => setStage({ kind: 'redeem' })}>
            Have a reset link already? Paste it.
          </button>
        </div>
      </div>
    );
  }

  if (stage.kind === 'redeem' || stage.kind === 'redeeming') {
    const busy = stage.kind === 'redeeming';
    return (
      <div className="signin">
        <form className="signin__card" onSubmit={handleRedeem}>
          <h1 className="signin__title">Fathom</h1>
          <p className="signin__subtitle">Choose a new password.</p>

          <div className="signin__field">
            <label className="signin__label" htmlFor="reset-token">
              Reset token
            </label>
            <input
              id="reset-token"
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
          </div>

          <div className="signin__field">
            <label className="signin__label" htmlFor="reset-password">
              New password
            </label>
            <input
              id="reset-password"
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
            <label className="signin__label" htmlFor="reset-password-again">
              Again
            </label>
            <input
              id="reset-password-again"
              className="signin__input"
              type="password"
              autoComplete="new-password"
              value={again}
              onChange={(event) => setAgain(event.target.value)}
              disabled={busy}
              required
            />
          </div>

          <button className="signin__submit" type="submit" disabled={busy || token.trim().length === 0}>
            {busy ? 'Setting…' : 'Set the password'}
          </button>

          {refusal && (
            <div className="signin__refusal" role="alert">
              {refusal}
            </div>
          )}

          <p className="signin__note">
            A reset link works once and expires. Setting a password here does not sign you in: you sign in afterwards
            with the new password and your app code.
          </p>

          {onUseSignIn && (
            <button type="button" className="signin__switch" onClick={() => onUseSignIn()}>
              Back to sign-in
            </button>
          )}
        </form>
      </div>
    );
  }

  const busy = stage.kind === 'asking';
  return (
    <div className="signin">
      <form className="signin__card" onSubmit={handleAsk}>
        <h1 className="signin__title">Fathom</h1>
        <p className="signin__subtitle">Forgotten your password?</p>

        <div className="signin__field">
          <label className="signin__label" htmlFor="reset-address">
            Address
          </label>
          <input
            id="reset-address"
            className="signin__input"
            type="text"
            autoComplete="username"
            spellCheck={false}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            disabled={busy}
            required
          />
        </div>

        <button className="signin__submit" type="submit" disabled={busy || address.trim().length === 0}>
          {busy ? 'Asking…' : 'Send a reset link'}
        </button>

        {refusal && (
          <div className="signin__refusal" role="alert">
            {refusal}
          </div>
        )}

        <p className="signin__note">{RESET_ANSWER}</p>

        {onUseSignIn && (
          <button type="button" className="signin__switch" onClick={() => onUseSignIn()}>
            Back to sign-in
          </button>
        )}
      </form>
    </div>
  );
}

/**
 * The reset token in the address bar, if the person arrived by a link.
 *
 * Both `#reset=…` and `?reset=…` are read, the fragment first: a fragment is
 * not part of the request target (RFC 3986 §3.5), so a token carried there
 * does not travel to this server in the request line the way a query string
 * does. Which of the two the mailed link actually uses is the mail stream's
 * to settle — ADR-0055 cost/order item 5 — and this reads either rather than
 * guessing one and breaking on the other. A token that is not the right
 * shape is ignored here and refused by `parseToken` if it is pasted.
 *
 * Takes the location as an argument so a test can pass one; `App.tsx` passes
 * `window.location`.
 */
export function tokenFromLocation(location: { hash?: string; search?: string }): string | null {
  const fromHash = new URLSearchParams((location.hash ?? '').replace(/^#/, '')).get('reset');
  const fromQuery = new URLSearchParams(location.search ?? '').get('reset');
  const found = fromHash ?? fromQuery;
  return found && found.trim().length > 0 ? found.trim() : null;
}
