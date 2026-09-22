import { useEffect, useState, type FormEvent } from 'react';

import {
  beginSignIn,
  completeSignIn,
  isSecondFactorNeeded,
  NoEnrolledKeyError,
  signIn,
  type SignInChallenge,
} from '../api/auth';
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

/**
 * What a refused code says, on the step where the code is the only thing
 * that can have been wrong.
 *
 * The server answers its one uniform sentence here as everywhere else, and
 * this screen does not repeat it: by the time this step is on screen the
 * address and the password have verified once (that is what drew it), and
 * the second post carries the same two plus the code. So naming the code is
 * not a guess about which check refused — it is the only new thing in the
 * request. One sentence, and it says what to do next, because a person
 * reading it is either holding a code that has just rolled over or reaching
 * for the envelope with the recovery codes in it.
 */
export const VERIFICATION_CODE_REFUSED =
  'That code was not accepted — wait for your authenticator app’s next code and type it again, or use one of your recovery codes.';

/**
 * How long the server's sign-in challenge lives, in milliseconds.
 *
 * `sessions.rs`'s `NONCE_LIFETIME`, 120 seconds, read there on 2026-09-22.
 * **A copy of a server constant, and it is allowed to be stale**: everything
 * it decides here is whether this client posts a challenge or fetches
 * another first, and both are correct requests. A copy that drifted low
 * spends an extra challenge; one that drifted high costs one refusal that is
 * already handled below. Nothing is authorised on it.
 */
export const CHALLENGE_LIFETIME_MS = 120_000;

/**
 * How much of that lifetime step two is willing to spend before it stops
 * reusing the challenge in hand.
 *
 * Thirty seconds of headroom for the round trip, the argon2id verification
 * the server does on this path, and a clock that is not quite the server's.
 * Past this the challenge is dropped and a fresh one asked for — one more
 * `POST /session/challenge`, which is one source unit, against a refusal the
 * person cannot act on and a code they have to type again.
 */
export const CHALLENGE_REUSE_BUDGET_MS = 90_000;

/** Is the challenge taken at `issuedAtMs` worth posting, or should this step
 * ask for a fresh one first? */
export function challengeIsWorthPosting(issuedAtMs: number, now: number): boolean {
  return now - issuedAtMs < CHALLENGE_REUSE_BUDGET_MS;
}

/**
 * Had the challenge taken at `issuedAtMs` certainly expired by `now`?
 *
 * **The wire cannot be asked.** A sign-in whose nonce is not fresh is
 * answered `SessionError::SignInRefused` — `sessions.rs` maps it there under
 * the reason `nonce_not_fresh` — which is the same 401 and the same
 * `sign-in refused` body a wrong code gets, on purpose: one message for
 * every cause. So the only honest test is the clock, and it is used one way
 * only. Past the server's own lifetime the challenge is dead whatever else
 * was wrong, and re-posting the code costs the account bucket nothing it had
 * not already been charged. Inside the lifetime nothing is retried, because
 * "the code was wrong" is then the likelier reading and a blind second
 * attempt would spend two of the ten failures a window allows on one typo.
 */
export function challengeHasCertainlyExpired(issuedAtMs: number, now: number): boolean {
  return now - issuedAtMs >= CHALLENGE_LIFETIME_MS;
}

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
 * **Two steps, one challenge.** The answer that draws step two is a
 * rollback: the server wrote no chain entry, left the challenge nonce
 * unspent and counted nothing against the account, because this is a step in
 * a sign-in and not a failure of one. It does cost **one source unit**,
 * committed on its own, so that a password holder cannot run unlimited
 * argon2id against one challenge; a two-step sign-in is three units of the
 * per-source budget (challenge, probe, completion) and the budget was raised
 * to keep the number of sign-ins a shared address can make in a window what
 * it was. So step two posts the challenge step one already holds — same
 * session keypair, same nonce, same evidence signature — with the code
 * beside the password. A refusal at step two is a real one: it consumes the
 * nonce, so the try after it asks for a fresh challenge (`../api/auth.ts`'s
 * `beginSignIn` and `completeSignIn`).
 *
 * **A challenge does not live long enough to be left lying about.** The
 * server's nonce lasts two minutes (`sessions.rs`'s `NONCE_LIFETIME`), and a
 * person reading a code off a phone can easily spend that. So step two does
 * not post a challenge that is near the end of it: past
 * [`CHALLENGE_REUSE_BUDGET_MS`] it quietly asks for a fresh one and posts
 * that instead, and if an answer comes back refusing a challenge that has by
 * then certainly expired, it asks for a fresh one and posts the same code
 * once more. Either way the person types their code once and sees no
 * sentence about a nonce — a word that means nothing to them and names
 * nothing they can fix.
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
  /** Which step the card is on. Not `null` means step two, and it carries
   * the address the server said it wanted a code for — so the field above
   * cannot be edited out from under the answer — and the challenge that
   * answer left unspent. */
  const [secondFactor, setSecondFactor] = useState<SecondFactorState | null>(null);
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

  /** Step one: the address, the password, and no code. */
  async function attempt(id: string, kind?: SlotIdentity['kind']) {
    setBusy(id);
    setRefusal(null);
    try {
      const challenge = await beginSignIn(id, kind, { password });
      try {
        await completeSignIn(challenge, { password });
      } catch (error) {
        // ADR-0056 decision 3: this answer is a step, not a wall. The
        // address and the password verified and the account holds a
        // confirmed authenticator. The server rolled its transaction back —
        // no entry, nothing against the account's bucket, and the nonce
        // still unspent — so the challenge in hand is the one step two posts
        // again, with the code beside the password. What the probe does cost
        // is one unit of the per-source budget, committed on its own so that
        // a password holder cannot run unlimited argon2id against one
        // challenge. Asking for a second challenge here would pay that
        // twice for one sign-in.
        if (isSecondFactorNeeded(error)) {
          setSecondFactor({ address: id, challenge, issuedAtMs: Date.now() });
          setCode('');
          return;
        }
        throw error;
      }
    } catch (error) {
      console.error(error);
      setRefusal(describe(error));
    } finally {
      setBusy(null);
    }
  }

  /** Step two: the same challenge, the same password, and the code. */
  async function attemptWithCode(step: SecondFactorState, verificationCode: string) {
    setBusy(step.address);
    setRefusal(null);
    try {
      // The challenge this step arrived with is posted again only while it
      // is worth posting. Past that — a person who went to find their phone
      // — and after a refusal has spent it, this try asks for its own:
      // `signIn` is the pair of calls back to back, which is exactly a fresh
      // challenge and one post.
      const held =
        step.challenge !== null && challengeIsWorthPosting(step.issuedAtMs, Date.now())
          ? step.challenge
          : null;
      if (held === null) {
        await signIn(step.address, undefined, { password, verificationCode });
      } else {
        try {
          await completeSignIn(held, { password, verificationCode });
        } catch (error) {
          // **One transparent retry, and only for a challenge that is dead
          // by the clock.** The server answers a stale nonce and a wrong
          // code with the same sentence (see
          // [`challengeHasCertainlyExpired`]), so the clock is what decides:
          // if the nonce cannot still have been alive when the answer came
          // back, the refusal is about the challenge and not about the code,
          // and the person should not be told to try a code they typed
          // correctly. A rate limit is never retried — it is the one refusal
          // that says what to do, and asking again would be asking for a
          // second one.
          if (
            !(error instanceof ApiRefusal) ||
            error.status === 429 ||
            error.retryAfterSeconds != null ||
            !challengeHasCertainlyExpired(step.issuedAtMs, Date.now())
          ) {
            throw error;
          }
          console.error(error);
          await signIn(step.address, undefined, { password, verificationCode });
        }
      }
    } catch (error) {
      console.error(error);
      // A refused code is a sealed, counted refusal and it consumes the
      // nonce — only the second-factor probe is rolled back. So whatever
      // went wrong, the challenge is gone and the next try asks for a new
      // one. The person stays on this step: the password is still right, and
      // sending them back to type it again would be this screen's own
      // invention.
      setSecondFactor({ address: step.address, challenge: null, issuedAtMs: Date.now() });
      setRefusal(describeCode(error));
    } finally {
      setBusy(null);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (secondFactor !== null) {
      await attemptWithCode(secondFactor, code);
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

  if (secondFactor !== null) {
    return (
      <SecondFactorStep
        address={secondFactor.address}
        code={code}
        busy={busy !== null}
        refusal={refusal}
        onCode={setCode}
        onSubmit={(event) => void handleSubmit(event)}
        onStartAgain={() => {
          setSecondFactor(null);
          setPassword('');
          setCode('');
          setRefusal(null);
        }}
      />
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

/** Step two's state: who it is for, and the challenge step one left unspent
 * — `null` once a refusal has consumed it, which is what tells the next try
 * to ask for a fresh one. */
interface SecondFactorState {
  address: string;
  challenge: SignInChallenge | null;
  /** `Date.now()` when this step was drawn, which is within a round trip of
   * when the server issued the nonce. What decides whether the challenge is
   * still worth posting — the server's own lifetime is two minutes and a
   * person reading a code off a phone can spend it. */
  issuedAtMs: number;
}

export interface SecondFactorStepProps {
  /** The address the server asked for a code for. Shown, never editable:
   * the code is bound to the account the password already verified against. */
  address: string;
  code: string;
  busy: boolean;
  refusal: string | null;
  onCode: (code: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /** Back to step one, with the password and the code cleared. */
  onStartAgain: () => void;
}

/**
 * Step two of the door: one field, and a way back.
 *
 * A pure component, drawn from its props alone, for the reason
 * `Account.tsx`'s stages are: this step is reached only through a live answer
 * from the server, and a screen no test can render is a screen whose wording
 * nobody checks. `SignIn.render.test.ts` renders it with a refusal in hand,
 * which is the state a wrong code leaves it in. ADR-0056 decisions 3 and 4.
 * 2026-09-22.
 */
export function SecondFactorStep({
  address,
  code,
  busy,
  refusal,
  onCode,
  onSubmit,
  onStartAgain,
}: SecondFactorStepProps) {
  return (
    <div className="signin">
      <form className="signin__card" onSubmit={onSubmit}>
        <h1 className="signin__title">Fathom</h1>
        <p className="signin__subtitle">{secondFactorIntro(address)}</p>

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
            onChange={(event) => onCode(event.target.value)}
            disabled={busy}
            required
          />
          <p className="signin__hint">{VERIFICATION_CODE_HINT}</p>
        </div>

        <button className="signin__submit" type="submit" disabled={busy || code.trim().length === 0}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {refusal && (
          <div className="signin__refusal" role="alert">
            {refusal}
          </div>
        )}

        <button type="button" className="signin__switch" onClick={onStartAgain}>
          Sign in as someone else
        </button>
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

/** The same, on step two, where the code is the only new thing in the
 * request — see `VERIFICATION_CODE_REFUSED`. A wait is still the server's own
 * sentence: it is the one refusal written for the person. */
function describeCode(error: unknown): string {
  if (error instanceof ApiRefusal && error.retryAfterSeconds != null) {
    return `${error.message} Try again in ${error.retryAfterSeconds}s.`;
  }
  if (error instanceof ApiRefusal) {
    return VERIFICATION_CODE_REFUSED;
  }
  return 'Sign-in did not complete. See the console for detail.';
}
