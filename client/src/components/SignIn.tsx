import { useState, type FormEvent } from 'react';

import { NoEnrolledKeyError, signIn } from '../api/auth';
import { PRINCIPAL_KIND_OPERATOR, PRINCIPAL_KIND_STEWARD, type PrincipalKind } from '../api/constants';
import { ApiRefusal } from '../api/errors';
import '../styles/signin.css';

export interface SignInProps {
  /** Go to the enrolment screen, which puts a key in this browser by
   * redeeming an invitation. Optional so this screen still stands alone. */
  onRedeemInvitation?: () => void;
}

/**
 * Sign-in, and nothing else. No password field: there is nowhere one could
 * go (`crates/fathom-server/src/api.rs`'s `sign_in_handler`). No
 * self-registration: enrolment is by invitation
 * (`docs/OPEN-QUESTIONS.md` B5), so this screen signs in with a key this
 * browser already holds and sends anyone without one to `Enrol`.
 *
 * Two planes (`../api/constants.ts`): an account signs in at its address;
 * an operator with the operator id the enrolment answer handed them, which
 * the console shows beside their name and the server's first-start log line
 * names. Same key, same challenge, one word different on the wire.
 */
export function SignIn({ onRedeemInvitation }: SignInProps = {}) {
  const [principalKind, setPrincipalKind] = useState<PrincipalKind>(PRINCIPAL_KIND_STEWARD);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const isOperator = principalKind === PRINCIPAL_KIND_OPERATOR;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setRefusal(null);
    try {
      await signIn(address.trim(), principalKind);
    } catch (error) {
      console.error(error);
      setRefusal(describe(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <form className="signin__card" onSubmit={handleSubmit}>
        <h1 className="signin__title">Fathom</h1>
        <p className="signin__subtitle">Sign in with your enrolled key.</p>

        <div className="signin__kinds" role="radiogroup" aria-label="Sign in as">
          <label className={isOperator ? 'signin__kind' : 'signin__kind signin__kind--on'}>
            <input
              type="radio"
              name="signin-kind"
              value={PRINCIPAL_KIND_STEWARD}
              checked={!isOperator}
              onChange={() => setPrincipalKind(PRINCIPAL_KIND_STEWARD)}
              disabled={busy}
            />
            An account
          </label>
          <label className={isOperator ? 'signin__kind signin__kind--on' : 'signin__kind'}>
            <input
              type="radio"
              name="signin-kind"
              value={PRINCIPAL_KIND_OPERATOR}
              checked={isOperator}
              onChange={() => setPrincipalKind(PRINCIPAL_KIND_OPERATOR)}
              disabled={busy}
            />
            An operator
          </label>
        </div>

        <div className="signin__field">
          <label className="signin__label" htmlFor="signin-address">
            {isOperator ? 'Operator id' : 'Address'}
          </label>
          <input
            id="signin-address"
            className={isOperator ? 'signin__input signin__input--mono' : 'signin__input'}
            type="text"
            autoComplete={isOperator ? 'off' : 'username'}
            spellCheck={false}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            disabled={busy}
            required
          />
        </div>

        <button
          className="signin__submit"
          type="submit"
          disabled={busy || address.trim().length === 0}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {refusal && (
          <div className="signin__refusal" role="alert">
            {refusal}
          </div>
        )}

        <p className="signin__note">
          {isOperator
            ? 'There is no password. The operator id was shown when your key was enrolled, and the console shows it.'
            : 'There is no password. Enrolment is by invitation.'}
        </p>

        {onRedeemInvitation && (
          <button type="button" className="signin__switch" onClick={onRedeemInvitation}>
            No key in this browser? Redeem an invitation or an operator token.
          </button>
        )}
      </form>
    </div>
  );
}

/** The server's own wording where it gave one; this client's own honest
 * statement of "I don't have that" where the server was never asked. Never
 * a guess at which check actually failed -- the server does not say, and
 * this screen must not invent it. */
function describe(error: unknown): string {
  if (error instanceof ApiRefusal) {
    return error.retryAfterSeconds != null
      ? `${error.message} Try again in ${error.retryAfterSeconds}s.`
      : error.message;
  }
  if (error instanceof NoEnrolledKeyError) {
    return error.message;
  }
  return 'Sign-in did not complete. See the console for detail.';
}
