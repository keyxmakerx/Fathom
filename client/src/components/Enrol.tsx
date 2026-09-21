import { useState, type FormEvent } from 'react';

import { signIn } from '../api/auth';
import { PRINCIPAL_KIND_OPERATOR, PRINCIPAL_KIND_STEWARD, type PrincipalKind } from '../api/constants';
import { ApiRefusal } from '../api/errors';
import {
  EnrolmentNotAttemptedError,
  EnrolmentOutcomeUnknownError,
  MalformedTokenError,
  parseToken,
  redeemAccountEnrolment,
  redeemOperatorEnrolment,
} from '../api/enrolment';
import '../styles/enrol.css';

type Stage =
  | { kind: 'form' }
  | { kind: 'enrolling' }
  | { kind: 'signing-in' }
  // Redemption was confirmed OK, but the follow-on sign-in did not complete.
  | { kind: 'enrolled-sign-in-failed'; principal: string; principalKind: PrincipalKind; detail: string }
  // Redemption's outcome could not be confirmed either way, and the sign-in
  // attempted with the pending key did not complete. Kept as its own stage,
  // with its own honest wording, rather than folded into the case above --
  // see the finding on `EnrolmentOutcomeUnknownError` in `../api/enrolment.ts`.
  | { kind: 'outcome-unknown-sign-in-failed'; principal: string; principalKind: PrincipalKind; detail: string }
  // An operator token whose outcome could not be confirmed: there is no id
  // to retry a sign-in with, because the id is what the answer would have
  // carried. The key waits in `OPERATOR_PENDING_SLOT`; sign-in with the id
  // from the server's first-start log line finds it.
  | { kind: 'outcome-unknown-operator'; detail: string };

/**
 * Redeem a token: paste it, say which kind it is, and end with an enrolled
 * key in this browser and a live session -- or the server's own refusal.
 *
 * Two kinds of token, two planes (`../api/constants.ts`): an **invitation**
 * to an account, redeemed with the address it was issued to, which is the
 * door every steward arrives by; and an **operator token** -- the one the
 * server wrote to a file at first start, or one a second operator's request
 * produced -- which names its operator itself and takes no address.
 *
 * No password field: there is nowhere one could go
 * (`crates/fathom-server/src/admin.rs`'s module header, "no password field
 * anywhere in this file"). The token is a bearer secret with one use, so it
 * is held only in this component's own state -- never a URL, a query
 * string, a log line, or `localStorage` -- and is cleared only once
 * redemption is *confirmed* OK, so a later reload of this screen has
 * nothing left to resend. When the outcome could not be confirmed either
 * way, the field is deliberately left as typed -- see `handleSubmit`.
 */
export interface EnrolProps {
  /** Go back to sign-in, for a browser that already holds a key. Optional
   * so this screen still stands alone. */
  onUseExistingKey?: () => void;
}

export function Enrol({ onUseExistingKey }: EnrolProps = {}) {
  const [principalKind, setPrincipalKind] = useState<PrincipalKind>(PRINCIPAL_KIND_STEWARD);
  const [token, setToken] = useState('');
  const [address, setAddress] = useState('');
  const [stage, setStage] = useState<Stage>({ kind: 'form' });
  const [refusal, setRefusal] = useState<string | null>(null);

  const busy = stage.kind === 'enrolling' || stage.kind === 'signing-in';
  const isOperator = principalKind === PRINCIPAL_KIND_OPERATOR;

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

    // Whether redemption's outcome was confirmed at all -- distinct from
    // whether it was confirmed *OK*. See `EnrolmentOutcomeUnknownError` in
    // `../api/enrolment.ts`: this is the one case where this screen must
    // not say "refused" (the server may have accepted it) and must not say
    // "enrolled" either (this browser could not confirm that).
    let outcomeUnknown = false;
    // Who to sign in as: the address for an account; for an operator, the
    // id the server's answer names, which is unknown until it has.
    let principal = trimmedAddress;
    try {
      if (isOperator) {
        principal = (await redeemOperatorEnrolment(tokenBytes)).operatorId;
      } else {
        await redeemAccountEnrolment(tokenBytes, trimmedAddress);
      }
    } catch (error) {
      console.error(error);
      if (error instanceof EnrolmentOutcomeUnknownError) {
        outcomeUnknown = true;
      } else {
        // A definite refusal (`ApiRefusal`), or nothing was sent at all
        // (`EnrolmentNotAttemptedError`) -- either way, the token is
        // exactly as usable as before this attempt, so the field is left
        // as typed rather than cleared.
        setStage({ kind: 'form' });
        setRefusal(describeRefusal(error));
        return;
      }
    }

    if (outcomeUnknown && isOperator) {
      // No id to sign in with: the answer that would have carried it was
      // never read. The token is left as typed, for the same reason as the
      // account case below.
      setStage({ kind: 'outcome-unknown-operator', detail: describeRefusal(new EnrolmentOutcomeUnknownError(null)) });
      return;
    }

    if (!outcomeUnknown) {
      // Confirmed OK. Clear the token now, before anything else, so this
      // screen has nothing left that could be resent -- the server's
      // answer already told it the token is spent, and a reload from here
      // must never suggest trying it again.
      setToken('');
    }
    // If the outcome was unknown, the token is deliberately left as typed:
    // if it was never accepted, retyping it costs nothing; if it was, the
    // server's own uniform refusal on a retry says so and nothing is lost.

    setStage({ kind: 'signing-in' });
    try {
      // `signIn` (`../api/auth.ts`) tries the enrolled key first and falls
      // back to a pending one -- which is exactly what a browser in the
      // `outcomeUnknown` state holds, per `EnrolmentOutcomeUnknownError`'s
      // doc comment. A successful sign-in here is what actually confirms,
      // after the fact, that an unknown-outcome redemption did land.
      await signIn(principal, principalKind);
      // `signIn` calls `setSession`, which the shell listens for; this
      // component does not navigate itself.
    } catch (error) {
      console.error(error);
      setStage({
        kind: outcomeUnknown ? 'outcome-unknown-sign-in-failed' : 'enrolled-sign-in-failed',
        principal,
        principalKind,
        detail: describeRefusal(error),
      });
    }
  }

  async function retrySignIn(
    stageKind: 'enrolled-sign-in-failed' | 'outcome-unknown-sign-in-failed',
    principal: string,
    kind: PrincipalKind,
  ) {
    setStage({ kind: 'signing-in' });
    try {
      await signIn(principal, kind);
    } catch (error) {
      console.error(error);
      setStage({ kind: stageKind, principal, principalKind: kind, detail: describeRefusal(error) });
    }
  }

  if (stage.kind === 'enrolled-sign-in-failed') {
    return (
      <div className="enrol">
        <div className="enrol__card">
          <h1 className="enrol__title">Fathom</h1>
          <p className="enrol__subtitle">Key enrolled.</p>
          <p className="enrol__body">
            The key for {describePrincipal(stage.principal, stage.principalKind)} is now in this browser, but
            signing in with it did not complete: {stage.detail}
          </p>
          <button
            type="button"
            className="enrol__submit"
            onClick={() => retrySignIn('enrolled-sign-in-failed', stage.principal, stage.principalKind)}
          >
            Try signing in again
          </button>
        </div>
      </div>
    );
  }

  if (stage.kind === 'outcome-unknown-sign-in-failed') {
    return (
      <div className="enrol">
        <div className="enrol__card">
          <h1 className="enrol__title">Fathom</h1>
          <p className="enrol__subtitle">Could not confirm the invitation was accepted.</p>
          <p className="enrol__body">
            This browser could not tell whether the server accepted the token for{' '}
            {describePrincipal(stage.principal, stage.principalKind)}, and signing in did not complete either:{' '}
            {stage.detail} If this keeps happening, ask for a new invitation.
          </p>
          <button
            type="button"
            className="enrol__submit"
            onClick={() => retrySignIn('outcome-unknown-sign-in-failed', stage.principal, stage.principalKind)}
          >
            Try signing in again
          </button>
        </div>
      </div>
    );
  }

  if (stage.kind === 'outcome-unknown-operator') {
    return (
      <div className="enrol">
        <div className="enrol__card">
          <h1 className="enrol__title">Fathom</h1>
          <p className="enrol__subtitle">Could not confirm the operator token was accepted.</p>
          <p className="enrol__body">
            {stage.detail} The key this browser generated is kept. If the server did accept the token, sign in
            as an operator with the operator id from the server&apos;s first-start log line (
            <code>operator_id=</code>) and that key will be used; if it did not, redeem the token again.
          </p>
          {onUseExistingKey && (
            <button type="button" className="enrol__submit" onClick={onUseExistingKey}>
              Go to sign-in
            </button>
          )}
          <button type="button" className="enrol__switch" onClick={() => setStage({ kind: 'form' })}>
            Redeem the token again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="enrol">
      <form className="enrol__card" onSubmit={handleSubmit}>
        <h1 className="enrol__title">Fathom</h1>
        <p className="enrol__subtitle">{isOperator ? 'Redeem an operator token.' : 'Redeem your invitation.'}</p>

        <div className="enrol__kinds" role="radiogroup" aria-label="What kind of token">
          <label className={isOperator ? 'enrol__kind' : 'enrol__kind enrol__kind--on'}>
            <input
              type="radio"
              name="enrol-kind"
              value={PRINCIPAL_KIND_STEWARD}
              checked={!isOperator}
              onChange={() => setPrincipalKind(PRINCIPAL_KIND_STEWARD)}
              disabled={busy}
            />
            An invitation to an account
          </label>
          <label className={isOperator ? 'enrol__kind enrol__kind--on' : 'enrol__kind'}>
            <input
              type="radio"
              name="enrol-kind"
              value={PRINCIPAL_KIND_OPERATOR}
              checked={isOperator}
              onChange={() => setPrincipalKind(PRINCIPAL_KIND_OPERATOR)}
              disabled={busy}
            />
            An operator token
          </label>
        </div>

        <div className="enrol__field">
          <label className="enrol__label" htmlFor="enrol-token">
            {isOperator ? 'Operator token' : 'Invitation token'}
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

        {!isOperator && (
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
        )}

        <button
          className="enrol__submit"
          type="submit"
          disabled={busy || token.trim().length === 0 || (!isOperator && address.trim().length === 0)}
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
          {isOperator
            ? 'The first operator token is in the file the server wrote at first start; later ones come from ' +
              'the console. The token names its operator and can only be used once.'
            : 'The address must be the one the invitation was sent to. The token can only be used once.'}
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

function describePrincipal(principal: string, kind: PrincipalKind): string {
  return kind === PRINCIPAL_KIND_OPERATOR ? `operator ${principal}` : principal;
}

/** The server's own wording where it gave one; this screen adds nothing --
 * see `../api/errors.ts` and `operators.rs`'s `EnrolmentRefused` on why one
 * refusal covers several causes and none of them is guessed here.
 *
 * `EnrolmentNotAttemptedError` and `EnrolmentOutcomeUnknownError` each carry
 * their own honest wording ("nothing was sent" versus "may have been
 * accepted") and are returned unchanged -- collapsing either into the
 * generic fallback below would be exactly the "refused" / "accepted and
 * lost" conflation this function exists to avoid. */
function describeRefusal(error: unknown): string {
  if (error instanceof ApiRefusal) {
    return error.retryAfterSeconds != null
      ? `${error.message} Try again in ${error.retryAfterSeconds}s.`
      : error.message;
  }
  if (error instanceof EnrolmentNotAttemptedError || error instanceof EnrolmentOutcomeUnknownError) {
    return error.message;
  }
  return 'Did not complete, and this browser cannot say why. See the console for detail.';
}
