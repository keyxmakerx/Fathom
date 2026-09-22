import { useState, type FormEvent } from 'react';

import { signIn } from '../api/auth';
import { PRINCIPAL_KIND_OPERATOR, PRINCIPAL_KIND_STEWARD, type PrincipalKind } from '../api/constants';
import { ApiRefusal } from '../api/errors';
import {
  EnrolmentNotAttemptedError,
  EnrolmentOutcomeUnknownError,
  MalformedTokenError,
  OperatorKeyWaitingError,
  parseToken,
  redeemAccountEnrolment,
  redeemOperatorEnrolment,
  type TokenKind,
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
  | { kind: 'outcome-unknown-operator'; detail: string }
  // A waiting key from an earlier unconfirmed operator enrolment stopped
  // this attempt before anything was sent (`OperatorKeyWaitingError`):
  // the person decides whether to keep it or discard it.
  | { kind: 'operator-key-waiting'; detail: string };

/**
 * Redeem a token: paste it, and end with an enrolled key in this browser
 * and a live session -- or the server's own refusal.
 *
 * **No choice of plane.** The token says which door it is for
 * (`../api/enrolment.ts`'s `parseToken`: `op_` an operator's, `inv_` an
 * account's invitation), and the address field appears only when an
 * invitation needs it. A bare token from before the prefixes is read by
 * whether an address was typed: none, and it is taken for an operator's.
 * The owner's rule, 2026-09-21: *"if they have access they have access, it
 * shouldn't be a selection"*.
 *
 * No password field: `POST /enrolment/account` takes `LP(token) ‖
 * LP(address) ‖ LP(public_key)` and nothing else, and ADR-0055 left this
 * door exactly as it was — an invitation is redeemed with a key, and the
 * password and authenticator app are set afterwards on the account screen.
 * The token
 * is a bearer secret with one use, so it
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
  /**
   * A token this client already has — read out of the fragment of the
   * address the invitation carries (`invitationFromLocation`, ADR-0056
   * decision 6). The field opens with it in place; it is still the person's
   * to edit, and the address an invitation needs is still asked for.
   */
  initialToken?: string;
}

/** What the token field says about itself as it is typed: which door, or
 * nothing yet (empty, malformed, or a bare token). Read live so the address
 * field can come and go with it. */
function kindOfTyped(token: string): TokenKind {
  try {
    return parseToken(token).kind;
  } catch {
    return null;
  }
}

export function Enrol({ onUseExistingKey, initialToken }: EnrolProps = {}) {
  const [token, setToken] = useState(initialToken ?? '');
  const [address, setAddress] = useState('');
  const [stage, setStage] = useState<Stage>({ kind: 'form' });
  const [refusal, setRefusal] = useState<string | null>(null);

  const busy = stage.kind === 'enrolling' || stage.kind === 'signing-in';
  const typedKind = kindOfTyped(token);
  // The address is asked for unless the token has said it is an operator's.
  const wantsAddress = typedKind !== 'operator';

  async function handleSubmit(event: FormEvent<HTMLFormElement>, replaceWaitingKey = false) {
    event.preventDefault();
    setRefusal(null);

    let parsed: ReturnType<typeof parseToken>;
    try {
      parsed = parseToken(token);
    } catch (error) {
      setRefusal(error instanceof MalformedTokenError ? error.message : 'That token could not be read.');
      return;
    }
    if (parsed.kind === 'organisation') {
      setRefusal(
        'That is an organisation claim, not a sign-in token. Nothing redeems one yet (docs/NEXT.md); keep it.',
      );
      return;
    }

    const trimmedAddress = address.trim();
    // The door: what the token says, else what was typed. An invitation
    // needs its address; a bare token with none typed is an operator's.
    const principalKind: PrincipalKind =
      parsed.kind === 'operator' || (parsed.kind === null && trimmedAddress.length === 0)
        ? PRINCIPAL_KIND_OPERATOR
        : PRINCIPAL_KIND_STEWARD;
    const isOperator = principalKind === PRINCIPAL_KIND_OPERATOR;
    if (!isOperator && trimmedAddress.length === 0) {
      setRefusal('An invitation is redeemed with the address it was sent to.');
      return;
    }

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
        principal = (await redeemOperatorEnrolment(parsed.bytes, { replaceWaitingKey })).operatorId;
      } else {
        await redeemAccountEnrolment(parsed.bytes, trimmedAddress);
      }
    } catch (error) {
      console.error(error);
      if (error instanceof EnrolmentOutcomeUnknownError) {
        outcomeUnknown = true;
      } else if (error instanceof OperatorKeyWaitingError) {
        // Nothing was sent. The token stays as typed; the person chooses.
        setStage({ kind: 'operator-key-waiting', detail: error.message });
        return;
      } else {
        // A definite refusal (`ApiRefusal`), or nothing was sent at all
        // (`EnrolmentNotAttemptedError`) -- either way, the token is
        // exactly as usable as before this attempt, so the field is left
        // as typed rather than cleared.
        setStage({ kind: 'form' });
        setRefusal(describeRefusal(error, parsed.kind === null && isOperator));
        return;
      }
    }

    if (outcomeUnknown && isOperator) {
      // No id to sign in with: the answer that would have carried it was
      // never read. The token is left as typed; a retry is guarded by
      // `OperatorKeyWaitingError`, because the waiting key may be the only
      // one the server will ever accept for this operator.
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
    // server's own uniform refusal on a retry says so, and the pending key
    // that refusal deletes is one an operator can replace by reissuing the
    // invitation (an account's key, unlike the first operator's, is not the
    // last of its kind).

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

  if (stage.kind === 'outcome-unknown-operator' || stage.kind === 'operator-key-waiting') {
    const waiting = stage.kind === 'operator-key-waiting';
    return (
      <div className="enrol">
        <form className="enrol__card" onSubmit={(event) => handleSubmit(event, true)}>
          <h1 className="enrol__title">Fathom</h1>
          <p className="enrol__subtitle">
            {waiting ? 'A key from an earlier attempt is waiting.' : 'Could not confirm the operator token was accepted.'}
          </p>
          <p className="enrol__body">
            {waiting ? (
              stage.detail
            ) : (
              <>
                {stage.detail} The key this browser generated is kept. If the server did accept the token, it is
                the only key that can sign in as that operator: go to sign-in and use the operator id from the
                server&apos;s first-start log line (<code>operator_id=</code>). Only if you are sure the token was
                never accepted, discard that key and redeem again.
              </>
            )}
          </p>
          {onUseExistingKey && (
            <button type="button" className="enrol__submit" onClick={onUseExistingKey}>
              Go to sign-in
            </button>
          )}
          <button type="submit" className="enrol__switch" disabled={busy || token.trim().length === 0}>
            Discard the waiting key and redeem the token again
          </button>
          <button type="button" className="enrol__switch" onClick={() => setStage({ kind: 'form' })}>
            Back
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="enrol">
      <form className="enrol__card" onSubmit={handleSubmit}>
        <h1 className="enrol__title">Fathom</h1>
        <p className="enrol__subtitle">Redeem your token.</p>

        <div className="enrol__field">
          <label className="enrol__label" htmlFor="enrol-token">
            Token
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

        {wantsAddress && (
          <div className="enrol__field">
            <label className="enrol__label" htmlFor="enrol-address">
              {typedKind === 'steward' ? 'Address' : 'Address (for an invitation; leave empty for an operator token)'}
            </label>
            <input
              id="enrol-address"
              className="enrol__input"
              type="text"
              autoComplete="username"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              disabled={busy}
              required={typedKind === 'steward'}
            />
          </div>
        )}

        <button className="enrol__submit" type="submit" disabled={busy || token.trim().length === 0}>
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
          {typedKind === 'operator'
            ? 'An operator token: the one the server wrote at first start, or one the console issued. It names ' +
              'its operator and works once.'
            : 'An invitation is redeemed with the address it was sent to. Every token works once. Redeeming one ' +
              'asks for no password: the key this browser generates is what proves the account is yours. A ' +
              'password and an authenticator app are set afterwards, on your own account screen.'}
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
 * lost" conflation this function exists to avoid.
 *
 * `guessedOperator`: a bare token with no address was taken for an
 * operator's, and the server refused it. The refusal is the server's own
 * words; the one thing this screen can add without guessing at the cause is
 * that the other reading exists. */
function describeRefusal(error: unknown, guessedOperator = false): string {
  if (error instanceof ApiRefusal) {
    const base =
      error.retryAfterSeconds != null ? `${error.message} Try again in ${error.retryAfterSeconds}s.` : error.message;
    return guessedOperator ? `${base} If this is an invitation to an account, add the address it was sent to.` : base;
  }
  if (error instanceof EnrolmentNotAttemptedError || error instanceof EnrolmentOutcomeUnknownError) {
    return error.message;
  }
  return 'Did not complete, and this browser cannot say why. See the console for detail.';
}

/**
 * The invitation token in the address bar, if the person followed the link
 * the console minted — `/invite#inv_<64 hex>` (ADR-0056 decision 6).
 *
 * **The fragment, and only the fragment.** A fragment is not part of the
 * request target (RFC 3986 §3.5), so a token carried there never reaches this
 * server's request line, its access log or any proxy's — which is the whole
 * reason the invitation carries it there rather than in a query string, and
 * why this does not also read `?`. `App.tsx` clears it from the address bar
 * as soon as it has been read, so a reload, a bookmark or a shared URL does
 * not carry the token any further.
 *
 * The path is checked too: a `#inv_…` on some other page is not an invitation
 * link, and opening a door on it would be this client guessing. A token of
 * the wrong shape is ignored by nothing here and refused by `parseToken` when
 * it is submitted, which is where every other malformed token is refused.
 *
 * Takes the location as an argument so a test can pass one, exactly as
 * `Reset.tsx`'s `tokenFromLocation` does; `App.tsx` passes `window.location`.
 */
export function invitationFromLocation(location: { pathname?: string; hash?: string }): string | null {
  const path = (location.pathname ?? '').replace(/\/+$/, '');
  if (path !== '/invite') return null;
  const fragment = (location.hash ?? '').replace(/^#/, '').trim();
  if (fragment.length === 0) return null;
  return fragment;
}
