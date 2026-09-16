import { useState, type FormEvent } from 'react';

import { NoEnrolledKeyError, signIn } from '../api/auth';
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
 */
export function SignIn({ onRedeemInvitation }: SignInProps = {}) {
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setRefusal(null);
    try {
      await signIn(address.trim());
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

        <div className="signin__field">
          <label className="signin__label" htmlFor="signin-address">
            Address
          </label>
          <input
            id="signin-address"
            className="signin__input"
            type="text"
            autoComplete="username"
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

        <p className="signin__note">There is no password. Enrolment is by invitation.</p>

        {onRedeemInvitation && (
          <button type="button" className="signin__switch" onClick={onRedeemInvitation}>
            No key in this browser? Redeem an invitation.
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
