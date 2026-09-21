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
}

/**
 * Sign-in, and nothing else. No password field: there is nowhere one could
 * go (`crates/fathom-server/src/api.rs`'s `sign_in_handler`). No
 * self-registration: enrolment is by invitation
 * (`docs/OPEN-QUESTIONS.md` B5), so this screen signs in with a key this
 * browser already holds and sends anyone without one to `Enrol`.
 *
 * **No choice of plane.** The key is the access, and it was filed under
 * one plane's slot when it was enrolled (`../api/constants.ts`), so this
 * screen lists the identities this browser holds a key for and signs in as
 * whichever is pressed; the field below is for typing one instead, and
 * `signIn` (`../api/auth.ts`) finds the key the same way. The owner's rule,
 * 2026-09-21: *"if they have access they have access, it shouldn't be a
 * selection"*.
 */
export function SignIn({ onRedeemInvitation }: SignInProps = {}) {
  const [identities, setIdentities] = useState<SlotIdentity[] | null>(null);
  const [address, setAddress] = useState('');
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
      await signIn(id, kind);
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

  const hasIdentities = identities !== null && identities.length > 0;

  return (
    <div className="signin">
      <form className="signin__card" onSubmit={handleSubmit}>
        <h1 className="signin__title">Fathom</h1>
        <p className="signin__subtitle">
          {hasIdentities ? 'Sign in with a key this browser holds.' : 'Sign in with your enrolled key.'}
        </p>

        {hasIdentities && (
          <div className="signin__identities">
            {identities.map((who) => (
              <button
                key={`${who.kind}:${who.id}`}
                type="button"
                className="signin__identity"
                disabled={busy !== null}
                onClick={() => attempt(who.id, who.kind)}
              >
                <span className="signin__identity-id">{who.id}</span>
                <span className="signin__identity-kind">
                  {busy === who.id ? 'signing in…' : who.kind === 'operator' ? 'operator' : 'account'}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="signin__field">
          <label className="signin__label" htmlFor="signin-address">
            {hasIdentities ? 'Or another address or operator id' : 'Address or operator id'}
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
            required={!hasIdentities}
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

        <p className="signin__note">There is no password. The key in this browser is the access.</p>

        {onRedeemInvitation && (
          <button type="button" className="signin__switch" onClick={onRedeemInvitation}>
            No key in this browser? Redeem a token.
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
