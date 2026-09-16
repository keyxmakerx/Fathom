import { useState, type FormEvent } from 'react';

import { signIn } from '../api/auth';
import { ApiRefusal } from '../api/errors';
import { MalformedTokenError, parseToken, redeemAccountEnrolment } from '../api/enrolment';
import '../styles/enrol.css';

type Stage =
  | { kind: 'form' }
  | { kind: 'enrolling' }
  | { kind: 'signing-in' }
  | { kind: 'enrolled-sign-in-failed'; address: string; detail: string };

/**
 * Redeem an invitation token: paste the token, give the address it was
 * issued to, and end with an enrolled key in this browser and a live
 * session -- or the server's own refusal.
 *
 * No password field: there is nowhere one could go
 * (`crates/fathom-server/src/admin.rs`'s module header, "no password field
 * anywhere in this file"). The token is a bearer secret with one use, so it
 * is held only in this component's own state -- never a URL, a query
 * string, a log line, or `localStorage` -- and is cleared the moment
 * redemption succeeds, so a later reload of this screen has nothing left to
 * resend.
 */
export interface EnrolProps {
  /** Go back to sign-in, for a browser that already holds a key. Optional
   * so this screen still stands alone. */
  onUseExistingKey?: () => void;
}

export function Enrol({ onUseExistingKey }: EnrolProps = {}) {
  const [token, setToken] = useState('');
  const [address, setAddress] = useState('');
  const [stage, setStage] = useState<Stage>({ kind: 'form' });
  const [refusal, setRefusal] = useState<string | null>(null);

  const busy = stage.kind === 'enrolling' || stage.kind === 'signing-in';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRefusal(null);

    let tokenBytes: Uint8Array;
    try {
      tokenBytes = parseToken(token);
    } catch (error) {
      setRefusal(error instanceof MalformedTokenError ? error.message : 'That token could not be read.');
      return;
    }

    const trimmedAddress = address.trim();
    setStage({ kind: 'enrolling' });
    try {
      await redeemAccountEnrolment(tokenBytes, trimmedAddress);
    } catch (error) {
      console.error(error);
      // The field is left as typed so a mistyped token can be corrected;
      // only a SUCCESSFUL redemption clears it.
      //
      // **This does not prove the token is unspent.** A refusal read off a
      // response means the server declined it, but a network failure after
      // the server committed lands here too, and in that case the token is
      // spent and this browser holds no key -- `putEnrolledKeyPair` below
      // runs only once the answer has been read. The person is then locked
      // out until an operator reissues the invitation, which
      // `/admin/accounts/{account}/enrolment` exists to do. Leaving the
      // field as typed is still right: retrying costs nothing and the
      // server's answer is the same either way.
      setStage({ kind: 'form' });
      setRefusal(describeRefusal(error));
      return;
    }

    // Redeemed. Clear the token now, before anything else, so this screen
    // has nothing left that could be resent -- the server's answer already
    // told it the token is spent, and a reload from here must never suggest
    // trying it again.
    setToken('');
    setStage({ kind: 'signing-in' });
    try {
      await signIn(trimmedAddress);
      // `signIn` calls `setSession`, which the shell listens for; this
      // component does not navigate itself.
    } catch (error) {
      console.error(error);
      setStage({
        kind: 'enrolled-sign-in-failed',
        address: trimmedAddress,
        detail: describeRefusal(error),
      });
    }
  }

  async function retrySignIn(addr: string) {
    setStage({ kind: 'signing-in' });
    try {
      await signIn(addr);
    } catch (error) {
      console.error(error);
      setStage({ kind: 'enrolled-sign-in-failed', address: addr, detail: describeRefusal(error) });
    }
  }

  if (stage.kind === 'enrolled-sign-in-failed') {
    return (
      <div className="enrol">
        <div className="enrol__card">
          <h1 className="enrol__title">Fathom</h1>
          <p className="enrol__subtitle">Key enrolled.</p>
          <p className="enrol__body">
            The key for {stage.address} is now in this browser, but signing in with it did not
            complete: {stage.detail}
          </p>
          <button
            type="button"
            className="enrol__submit"
            onClick={() => retrySignIn(stage.address)}
          >
            Try signing in again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="enrol">
      <form className="enrol__card" onSubmit={handleSubmit}>
        <h1 className="enrol__title">Fathom</h1>
        <p className="enrol__subtitle">Redeem your invitation.</p>

        <div className="enrol__field">
          <label className="enrol__label" htmlFor="enrol-token">
            Invitation token
          </label>
          <input
            id="enrol-token"
            className="enrol__input enrol__input--mono"
            type="text"
            inputMode="text"
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

        <div className="enrol__field">
          <label className="enrol__label" htmlFor="enrol-address">
            Address
          </label>
          <input
            id="enrol-address"
            className="enrol__input"
            type="text"
            autoComplete="username"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            disabled={busy}
            required
          />
        </div>

        <button
          className="enrol__submit"
          type="submit"
          disabled={busy || token.trim().length === 0 || address.trim().length === 0}
        >
          {stage.kind === 'enrolling'
            ? 'Enrolling…'
            : stage.kind === 'signing-in'
              ? 'Signing in…'
              : 'Enrol this browser'}
        </button>

        {refusal && (
          <div className="enrol__refusal" role="alert">
            {refusal}
          </div>
        )}

        <p className="enrol__note">
          The address must be the one the invitation was sent to. The token can only be used once.
        </p>

        {onUseExistingKey && (
          <button type="button" className="enrol__switch" onClick={onUseExistingKey}>
            Already enrolled in this browser? Sign in.
          </button>
        )}
      </form>
    </div>
  );
}

/** The server's own wording where it gave one; this screen adds nothing --
 * see `../api/errors.ts` and `operators.rs`'s `EnrolmentRefused` on why one
 * refusal covers several causes and none of them is guessed here. */
function describeRefusal(error: unknown): string {
  if (error instanceof ApiRefusal) {
    return error.retryAfterSeconds != null
      ? `${error.message} Try again in ${error.retryAfterSeconds}s.`
      : error.message;
  }
  return 'Did not complete. See the console for detail.';
}
