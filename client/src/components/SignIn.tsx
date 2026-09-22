import { useEffect, useState, type FormEvent } from 'react';

import { NoEnrolledKeyError, signIn } from '../api/auth';
import { identityOfSlot, OPERATOR_PENDING_SLOT, type SlotIdentity } from '../api/constants';
import { ApiRefusal } from '../api/errors';
import { listKeySlots } from '../crypto/keys';
import '../styles/signin.css';

export interface SignInProps {
  /** Go to the enrolment screen, which puts a key in this browser by
   * redeeming an invitation. Optional so this screen still stands alone. */
  onRedeemInvitation?: () => void;
  /** Go to the forgot-password screen. */
  onForgotPassword?: () => void;
  /** Go to the first operator's setup screen, for the token the server wrote
   * at its first start. */
  onFirstOperatorSetup?: () => void;
  /** Prefilled address — after a reset, or after setup, so the person does
   * not retype what this client already knows. */
  initialAddress?: string;
  /** One sentence above the form, from whatever sent the person here (a
   * completed reset, a session that ended). Never a refusal: those come from
   * the server and are shown below the button, verbatim. */
  notice?: string | null;
}

/**
 * Sign-in: the address, the password and the app code.
 *
 * **Any browser, no pairing** (ADR-0055 decision 6). Until 2026-09-21 this
 * screen had no password field because the server had nowhere to put one;
 * decision 10 puts the credential here, and the key this browser may hold is
 * now evidence sent beside it rather than the only way in. `signIn`
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
 * **One field for two kinds of code.** Six digits is the app code; one of the
 * ten backup codes goes in the same box, and the server tries it when the
 * first shape does not fit. The note under the field says so, because a
 * person reaching for a backup code has already lost their phone and should
 * not also have to guess where it goes.
 */
export function SignIn({
  onRedeemInvitation,
  onForgotPassword,
  onFirstOperatorSetup,
  initialAddress,
  notice,
}: SignInProps) {
  const [identities, setIdentities] = useState<SlotIdentity[] | null>(null);
  const [address, setAddress] = useState(initialAddress ?? '');
  const [password, setPassword] = useState('');
  const [appCode, setAppCode] = useState('');
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

  async function attempt(id: string, kind?: SlotIdentity['kind']) {
    setBusy(id);
    setRefusal(null);
    try {
      await signIn(id, kind, { password, appCode });
    } catch (error) {
      console.error(error);
      setRefusal(describe(error));
    } finally {
      setBusy(null);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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

  return (
    <div className="signin">
      <form className="signin__card" onSubmit={handleSubmit}>
        <h1 className="signin__title">Fathom</h1>
        <p className="signin__subtitle">
          Sign in with your address and your password. The app code is the six-digit number from your
          authenticator app, once you have enrolled one.
        </p>

        {notice && <p className="signin__notice">{notice}</p>}

        {onFirstOperatorSetup && (
          <p className="signin__hint">
            First time on this server? This form cannot create a password. Use the setup link at the bottom of
            this card with the token the server wrote.
          </p>
        )}

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

        <div className="signin__field">
          <label className="signin__label" htmlFor="signin-code">
            App code
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
            value={appCode}
            onChange={(event) => setAppCode(event.target.value)}
            disabled={busy !== null}
          />
          <p className="signin__hint">
            Six digits from your app. Leave it empty until you have enrolled one. Lost the phone? Type one of your backup codes here instead — each works once.
          </p>
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
            Forgotten your password?
          </button>
        )}

        {onRedeemInvitation && (
          <button type="button" className="signin__switch" onClick={onRedeemInvitation}>
            Invited? Redeem a token.
          </button>
        )}

        {onFirstOperatorSetup && (
          <button type="button" className="signin__switch" onClick={onFirstOperatorSetup}>
            First time on this server? Set up the first operator with the token the server wrote at first start.
          </button>
        )}
      </form>
    </div>
  );
}

/** What a refused sign-in says on this screen. The server answers one
 * sentence for every cause, on purpose, and that sentence is written for the
 * audit trail, not for the person typing. This lists every check that can
 * refuse, without guessing which one did -- the server does not say, and
 * this screen must not invent it. */
const SIGN_IN_REFUSED =
  'Sign-in refused. Check the address and the password, and the six digits if an app code is enrolled. ' +
  'Never set a password on this server? Use the setup link below.';

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
