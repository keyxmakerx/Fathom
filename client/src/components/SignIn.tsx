import { useEffect, useState, type FormEvent } from 'react';

import { isSecondFactorNeeded, NoEnrolledKeyError, signIn } from '../api/auth';
import { identityOfSlot, OPERATOR_PENDING_SLOT, type SlotIdentity } from '../api/constants';
import { ApiRefusal } from '../api/errors';
import { listKeySlots } from '../crypto/keys';
import '../styles/signin.css';

/** What step two says it is doing, and for whom. A function rather than
 * markup so that a runner with no DOM can check the wording: the second step
 * is reached only through a live refusal from the server (ADR-0056
 * decision 3), which a render-to-string pass cannot produce. */
export function secondFactorIntro(address: string): string {
  return `Signing in as ${address}. This account has an authenticator app, so it needs a code as well.`;
}

/** The hint under the one code field. Both kinds of code go in it, and the
 * person who needs the second kind has already lost their phone (ADR-0056
 * decisions 3 and 4). */
export const VERIFICATION_CODE_HINT =
  'Six digits from your authenticator app, or one of your recovery codes.';

export interface SignInProps {
  /** Go to the forgot-password screen. The one link under this card
   * (ADR-0056 decision 6). */
  onForgotPassword?: () => void;
  /** Prefilled address — after a reset, so the person does not retype what
   * this client already knows. */
  initialAddress?: string;
  /** One sentence above the form, from whatever sent the person here (a
   * completed reset, a session that ended). Never a refusal: those come from
   * the server and are shown below the button, verbatim. */
  notice?: string | null;
}

/**
 * Sign-in, in two steps: the address and the password, and then — only for an
 * account that holds a confirmed authenticator — the verification code.
 *
 * **Why two steps** (ADR-0056 decision 3). One card with three fields asked
 * everybody for a code most accounts do not have, and left the one field that
 * takes a recovery code sitting under a label about an app. The server now
 * answers a typed *second factor needed* to an address-and-password that
 * verifies against an account with a confirmed authenticator, and that answer
 * is what draws the second step. The ADR names what this gives up: the second
 * step tells the person who typed the right password that it was right. Every
 * surveyed product with a second factor makes the same trade, and a wrong
 * address or a wrong password still gets one sentence.
 *
 * **Any browser, no pairing** (ADR-0055 decision 6). `signIn`
 * (`../api/auth.ts`) presents a stored key automatically when there is one —
 * nothing on this screen mentions it, because a person signing in has nothing
 * to decide about it.
 *
 * **No choice of plane.** The identities below are the ones this browser
 * holds a key for; pressing one fills the address in (an operator id signs in
 * on the spot, since the operator plane is a key sign-in and carries no
 * password). The owner's rule, 2026-09-21: *"if they have access they have
 * access, it shouldn't be a selection"*.
 *
 * **One field for two kinds of code.** Six digits from the authenticator app;
 * one of the ten recovery codes goes in the same box, and the server tries it
 * when the first shape does not fit. The hint under the field says so,
 * because a person reaching for a recovery code has already lost their phone
 * and should not also have to guess where it goes. The field is
 * `autocomplete="one-time-code"`, which is what a password manager looks for
 * first, and its `inputMode` stays `text`: a numeric keypad would hide the
 * letters a recovery code is made of.
 *
 * **No setup door.** The server says whether this deployment has been set up
 * (ADR-0056 decision 1), so `App.tsx` shows the first-run flow or this card,
 * and this card no longer offers a link to either. An invitation is redeemed
 * at the address it carries, not from here.
 */
export function SignIn({ onForgotPassword, initialAddress, notice }: SignInProps) {
  const [identities, setIdentities] = useState<SlotIdentity[] | null>(null);
  const [address, setAddress] = useState(initialAddress ?? '');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  /** Which step the card is on. `second-factor` carries the address the
   * server said it wanted a code for, so that the field above cannot be
   * edited out from under the answer. */
  const [secondFactorFor, setSecondFactorFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listKeySlots()
      .then(({ enrolled, pending }) => {
        if (cancelled) return;
        // Enrolled first, then pending ones not already listed; never the
        // operator sentinel, whose owner is unknown until they type the id.
        const seen = new Set<string>();
        const rows: SlotIdentity[] = [];
        for (const slot of [...enrolled, ...pending]) {
          if (slot === OPERATOR_PENDING_SLOT || seen.has(slot)) continue;
          seen.add(slot);
          rows.push(identityOfSlot(slot));
        }
        setIdentities(rows);
      })
      .catch(() => {
        // Storage unavailable (a private window, cleared site data): the
        // typed field below still works, and says so honestly when it
        // finds nothing.
        if (!cancelled) setIdentities([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function attempt(id: string, kind?: SlotIdentity['kind'], verificationCode = '') {
    setBusy(id);
    setRefusal(null);
    try {
      await signIn(id, kind, { password, verificationCode });
    } catch (error) {
      console.error(error);
      // ADR-0056 decision 3: this refusal is a step, not a wall. The address
      // and the password verified and the account holds a confirmed
      // authenticator; nothing was issued and nothing was spent.
      if (isSecondFactorNeeded(error)) {
        setSecondFactorFor(id);
        setCode('');
        setRefusal(null);
        return;
      }
      setRefusal(describe(error));
    } finally {
      setBusy(null);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (secondFactorFor !== null) {
      // All three go up again: the server's one-request verification is
      // unchanged, and nothing is issued until all of it verifies.
      await attempt(secondFactorFor, undefined, code);
      return;
    }
    await attempt(address.trim());
  }

  /** An identity this browser holds a key for. An operator id is a key
   * sign-in with no password (`../api/auth.ts`), so it is pressed and done;
   * an account's address goes into the field above the password, because the
   * password is still required whenever the account has one. */
  function chooseIdentity(who: SlotIdentity) {
    if (who.kind === 'operator') {
      void attempt(who.id, who.kind);
      return;
    }
    setAddress(who.id);
    setRefusal(null);
  }

  const hasIdentities = identities !== null && identities.length > 0;

  if (secondFactorFor !== null) {
    return (
      <div className="signin">
        <form className="signin__card" onSubmit={(event) => void handleSubmit(event)}>
          <h1 className="signin__title">Fathom</h1>
          <p className="signin__subtitle">{secondFactorIntro(secondFactorFor)}</p>

          <div className="signin__field">
            <label className="signin__label" htmlFor="signin-code">
              Verification code
            </label>
            <input
              id="signin-code"
              className="signin__input signin__input--mono"
              type="text"
              inputMode="text"
              autoComplete="one-time-code"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={busy !== null}
              required
            />
            <p className="signin__hint">{VERIFICATION_CODE_HINT}</p>
          </div>

          <button
            className="signin__submit"
            type="submit"
            disabled={busy !== null || code.trim().length === 0}
          >
            {busy !== null ? 'Signing in…' : 'Sign in'}
          </button>

          {refusal && (
            <div className="signin__refusal" role="alert">
              {refusal}
            </div>
          )}

          <button
            type="button"
            className="signin__switch"
            onClick={() => {
              setSecondFactorFor(null);
              setPassword('');
              setCode('');
              setRefusal(null);
            }}
          >
            Sign in as someone else
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="signin">
      <form className="signin__card" onSubmit={(event) => void handleSubmit(event)}>
        <h1 className="signin__title">Fathom</h1>
        <p className="signin__subtitle">Sign in with your address and your password.</p>

        {notice && <p className="signin__notice">{notice}</p>}

        {hasIdentities && (
          <div className="signin__identities">
            {identities.map((who) => (
              <button
                key={`${who.kind}:${who.id}`}
                type="button"
                className="signin__identity"
                disabled={busy !== null}
                onClick={() => chooseIdentity(who)}
              >
                <span className="signin__identity-id">{who.id}</span>
                <span className="signin__identity-kind">
                  {busy === who.id ? 'signing in…' : who.kind === 'operator' ? 'operator' : 'this browser'}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="signin__field">
          <label className="signin__label" htmlFor="signin-address">
            Address
          </label>
          <input
            id="signin-address"
            className="signin__input"
            type="text"
            autoComplete="username"
            spellCheck={false}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            disabled={busy !== null}
            required
          />
        </div>

        <div className="signin__field">
          <label className="signin__label" htmlFor="signin-password">
            Password
          </label>
          <input
            id="signin-password"
            className="signin__input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy !== null}
          />
        </div>

        <button
          className="signin__submit"
          type="submit"
          disabled={busy !== null || address.trim().length === 0}
        >
          {busy !== null && busy === address.trim() ? 'Signing in…' : 'Sign in'}
        </button>

        {refusal && (
          <div className="signin__refusal" role="alert">
            {refusal}
          </div>
        )}

        {onForgotPassword && (
          <button type="button" className="signin__switch" onClick={onForgotPassword}>
            Forgot your password?
          </button>
        )}
      </form>
    </div>
  );
}

/** What a refused sign-in says on this screen. The server answers one
 * sentence for every cause, on purpose, and that sentence is written for the
 * audit trail, not for the person typing. This says what the person can act
 * on without guessing which check refused -- the server does not say, and
 * this screen must not invent it. Since ADR-0056 decision 1 it no longer
 * mentions setup: the server decides whether this deployment is on its first
 * run, and if it were, this card would not be on the screen at all. */
export const SIGN_IN_REFUSED = 'Sign-in refused. Check the address and the password.';

/** The server's own wording where it is meant for the person (a wait); the
 * sentence above for a refusal; this client's own honest statement of "I
 * don't have that" where the server was never asked. */
function describe(error: unknown): string {
  if (error instanceof ApiRefusal) {
    return error.retryAfterSeconds != null
      ? `${error.message} Try again in ${error.retryAfterSeconds}s.`
      : SIGN_IN_REFUSED;
  }
  if (error instanceof NoEnrolledKeyError) {
    return error.message;
  }
  return 'Sign-in did not complete. See the console for detail.';
}
