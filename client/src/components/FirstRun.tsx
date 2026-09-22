import { useState, type ComponentType, type FormEvent } from 'react';

import { signIn, signOut } from '../api/auth';
import { PRINCIPAL_KIND_STEWARD } from '../api/constants';
import { redeemOperatorSetup } from '../api/credentials';
import { parseToken } from '../api/enrolment';
import { ApiRefusal } from '../api/errors';
import { checkSetupToken, refreshSetupState } from '../api/setup';
import * as AccountModule from './Account';
import { describe } from './Account';
import '../styles/signin.css';

/**
 * The first run: one flow, five numbered steps, and while the server says
 * `pending` it is the only thing this client shows (ADR-0056 decisions 1 and
 * 2). It replaces `Setup.tsx`, which was one long form behind a link on the
 * sign-in door — three fields and three doors for a person who has just
 * installed the thing.
 *
 * The steps, and who draws each:
 *
 *   1. **Welcome.** The setup token, checked against
 *      `POST /enrolment/operator/setup/check`, which spends nothing and
 *      answers with the address the token is bound to. Here.
 *   2. **Choose a password** for that address — shown, never typed, so it
 *      cannot mismatch. `POST /enrolment/operator/setup` spends the token and
 *      sets the password; the sign-in straight after it is what turns the two
 *      into a session.  Here.
 *   3. **Set up your authenticator app**, and 4. **recovery codes** — the
 *      enrolment component on the account screen, which is the same two steps
 *      a person meets later from their own account and is not duplicated
 *      here.
 *   5. **Sign in with your new authenticator.** Here, and it is the step that
 *      makes the flow land where the ADR says it lands.
 *
 * **Why step 5 exists.** The session made at step 2 was minted from a
 * password alone, before the authenticator existed, so it is `A0`, and
 * `operators.rs`'s `register_own_operator_key` refuses `A0` outright — the
 * one press on Home that opens the operator console would be answered 403 and
 * the entry would take itself away for the rest of the session. Every other
 * route takes the `A0` session the moment the code is confirmed, because the
 * setup gate reads the account's live credentials on each request, so this
 * was invisible until somebody pressed Site. One more sign-in, with the code
 * the person has just proved they can produce, ends the setup session and
 * lands them on Home with an `A0T` one that the console takes.
 *
 * The token is held in this component's own state only — never a URL, a query
 * string, a log line or `localStorage` — and cleared the moment the server
 * confirms it is spent, exactly as `Enrol.tsx` handles an invitation. The
 * password is held the same way, for the one reason step 5 needs it, and
 * cleared with it.
 */

/**
 * Steps 3 and 4's screens, from the account screen's own module.
 *
 * ADR-0056 decision 4 takes "app code" out of every name a person reads, and
 * the other client stream renames this export `AuthenticatorEnrolment`. Both
 * names are looked for so that neither half of the build is broken while the
 * two streams are merged: the new name when it is there, today's name until
 * it is. The props are the same either way — `{ address, onDone }`.
 */
export interface AuthenticatorEnrolmentProps {
  address: string;
  onDone?: () => void;
}
type EnrolmentExports = Partial<
  Record<'AuthenticatorEnrolment' | 'AppCodeEnrolment', ComponentType<AuthenticatorEnrolmentProps>>
>;
const enrolmentExports = AccountModule as unknown as EnrolmentExports;
const AuthenticatorEnrolment: ComponentType<AuthenticatorEnrolmentProps> | null =
  enrolmentExports.AuthenticatorEnrolment ?? enrolmentExports.AppCodeEnrolment ?? null;

/** The fifteen-character floor, said inline on the screen that asks for a
 * password and checked here before the round trip. The server is what
 * enforces it (`credentials.rs`'s password policy, the one refusal that
 * explains itself); this only spares the person a refusal for something the
 * screen had already told them. */
const PASSWORD_MINIMUM = 15;

/** How many steps a person is walked through, and what each is called.
 * Steps 3 and 4 are drawn by the enrolment component, not here — they are
 * named in this one list so that the progress line and the ADR agree about
 * how long this is (ADR-0056 decision 2). */
export const FIRST_RUN_STEPS = [
  'Welcome',
  'Choose a password',
  'Set up your authenticator app',
  'Recovery codes',
  'Sign in with your new authenticator',
] as const;

/** "Step 2 of 5". */
export function progressLine(step: number): string {
  return `Step ${step} of ${FIRST_RUN_STEPS.length}`;
}

/** Step 2's opening sentence. The address is the server's answer to the
 * token, shown and never typed, so it cannot mismatch. A function rather
 * than markup so the wording is checked by a test in a runner with no DOM. */
export function passwordStepIntro(address: string): string {
  return (
    `The setup token belongs to ${address}. That is the address this server was started with, ` +
    'and it is the account this password is for — there is nothing to type and nothing to get wrong.'
  );
}

/** Step 3's opening sentence, above the enrolment component. */
export function authenticatorStepIntro(address: string): string {
  return (
    `Password set for ${address}. This account holds the operator custody, so it needs a second ` +
    'factor before it can do anything else. Your recovery codes come after this, and then one last sign-in.'
  );
}

/** Step 5's opening sentence, and the whole of the explanation a person
 * needs for being asked to sign in at the end of setting up. */
export function finalSignInStepIntro(address: string): string {
  return (
    `Your authenticator app is set up and your recovery codes are saved. Sign in once more as ` +
    `${address} with a code from the app: the session that set all this up was made before the ` +
    'app existed, so it has never proved the second factor, and the operator console does not ' +
    'take a session that has not.'
  );
}

/** What a refused setup token says, ADR-0056 decision 2 step 1 verbatim. The
 * server answers one sentence for wrong, spent, expired and malformed alike,
 * written for the audit trail; this is the one written for the person, and it
 * does not guess which of the four it was. */
export const SETUP_TOKEN_REFUSED =
  'Setup token is missing or invalid. Find the current token in the server’s token file.';

/**
 * What the sign-in door is told when the password was set but the sign-in
 * after it did not land.
 *
 * The token is spent by then — the server said so by answering — so there is
 * no step of this flow left to show, and the door is the only screen that can
 * use what the person now has. Said as a fact and not as a refusal: nothing
 * they did was wrong, and the password they just chose is the one to type.
 */
export const PASSWORD_SET_NOTICE = 'Your password is set. Sign in with it.';

/** What a refused code says at step 5. The server answers its uniform
 * sentence, and this screen does not repeat it: the password in hand is the
 * one this same flow set a minute ago, so the code is the only thing in the
 * request that can be wrong. One sentence, and it says what to do next. */
export const FIRST_RUN_CODE_REFUSED =
  'That code was not accepted — wait for your authenticator app’s next code and type it again, or use one of your recovery codes.';

export interface FirstRunProps {
  /**
   * The flow is finished: the password is set, the authenticator app is
   * confirmed, the recovery codes are saved, and the session this browser
   * now holds is one that proved the second factor (`A0T`). Home takes it,
   * and so does the one press that opens the operator console.
   */
  onDone?: (address: string) => void;
  /**
   * The password is set, but this flow cannot finish signing the person in
   * (step 2's sign-in failed, and the token it spent is gone). Show the
   * sign-in door with `address` prefilled and [`PASSWORD_SET_NOTICE`] above
   * it. Never the token step again: the token no longer exists, and blaming
   * it would be this screen inventing a cause.
   */
  onPasswordSet?: (address: string) => void;
}

type Step =
  | { kind: 'token' }
  | { kind: 'checking' }
  | { kind: 'password'; address: string }
  | { kind: 'setting'; address: string }
  | { kind: 'signing-in'; address: string }
  | { kind: 'authenticator'; address: string }
  | { kind: 'second-factor'; address: string }
  | { kind: 'final-sign-in'; address: string }
  | { kind: 'password-set'; address: string };

/** Which of [`FIRST_RUN_STEPS`] each state of this component is on. The
 * enrolment component draws steps 3 and 4 from one state here, so the line
 * says 3 for both: the sub-step is the child's and this flow does not ask
 * for it. */
const STEP_NUMBER: Record<Step['kind'], number> = {
  token: 1,
  checking: 1,
  password: 2,
  setting: 2,
  'signing-in': 2,
  authenticator: 3,
  'second-factor': 5,
  'final-sign-in': 5,
  'password-set': 2,
};

export function FirstRun({ onDone, onPasswordSet }: FirstRunProps) {
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'token' });
  const [refusal, setRefusal] = useState<string | null>(null);

  const busy =
    step.kind === 'checking' ||
    step.kind === 'setting' ||
    step.kind === 'signing-in' ||
    step.kind === 'final-sign-in';
  const progress = progressLine(STEP_NUMBER[step.kind]);

  /** Step 1. A read: the token is not spent here, so a mistyped line costs
   * nothing but this answer. */
  async function handleToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRefusal(null);

    let parsed: ReturnType<typeof parseToken>;
    try {
      parsed = parseToken(token);
    } catch (error) {
      // A line that is not a token's shape gets the same sentence a refused
      // one gets: the server does not tell wrong from spent from expired
      // (decision 2 step 1), and a client that told malformed from the rest
      // would be the one place a guess could start.
      console.error(error);
      setRefusal(SETUP_TOKEN_REFUSED);
      return;
    }
    if (parsed.kind === 'steward' || parsed.kind === 'organisation') {
      setRefusal(SETUP_TOKEN_REFUSED);
      return;
    }

    setStep({ kind: 'checking' });
    try {
      const address = await checkSetupToken(parsed.bytes);
      setStep({ kind: 'password', address });
    } catch (error) {
      console.error(error);
      setStep({ kind: 'token' });
      // A rate limit is the one refusal here that is about the person's next
      // move rather than about the token, and it says how long to wait.
      setRefusal(
        error instanceof ApiRefusal && error.retryAfterSeconds != null
          ? describe(error)
          : SETUP_TOKEN_REFUSED,
      );
    }
  }

  /**
   * The token is spent and the password is set, and this flow has nowhere
   * left to send the person: hand them to the sign-in door.
   *
   * **Ask the state route again first.** The deployment stopped being
   * `pending` the instant the token was spent, and the answer this page read
   * at boot is the one thing that would send the person back to a token step
   * for a token that no longer exists. `refreshSetupState` re-asks with a
   * five-second timeout; a timeout, a refusal or — the shape that should not
   * happen — a server still saying `pending` all end the same way, because
   * the password is set either way and the door is the only screen that can
   * use it. The odd answer is logged rather than acted on.
   */
  async function leaveForTheDoor(address: string) {
    try {
      const state = await refreshSetupState();
      if (state !== 'done') {
        console.error(
          'POST /enrolment/operator/setup answered, but GET /setup/state still says pending',
        );
      }
    } catch (error) {
      console.error(error);
    }
    setStep({ kind: 'password-set', address });
    onPasswordSet?.(address);
  }

  /** Step 2. Spends the token, then signs in with what was just set. */
  async function handlePassword(event: FormEvent<HTMLFormElement>, address: string) {
    event.preventDefault();
    setRefusal(null);

    if (password !== again) {
      setRefusal('The two passwords are not the same.');
      return;
    }
    if (password.length < PASSWORD_MINIMUM) {
      setRefusal('That password is shorter than fifteen characters.');
      return;
    }

    let parsed: ReturnType<typeof parseToken>;
    try {
      parsed = parseToken(token);
    } catch (error) {
      console.error(error);
      setStep({ kind: 'token' });
      setRefusal(SETUP_TOKEN_REFUSED);
      return;
    }

    setStep({ kind: 'setting', address });
    try {
      await redeemOperatorSetup(parsed.bytes, password);
    } catch (error) {
      console.error(error);
      // Nothing about the token has changed unless the server said it spent
      // it, and it says that by answering. A refusal leaves this step as it
      // was, the same reading `Enrol.tsx` makes.
      setStep({ kind: 'password', address });
      setRefusal(describe(error));
      return;
    }
    // Confirmed spent: nothing on this screen may suggest sending it again.
    setToken('');

    setStep({ kind: 'signing-in', address });
    try {
      // **No browser key yet.** ADR-0055 decision 9: the operator key wants a
      // confirmed authenticator behind it, and this account has none yet, so
      // a key registered here would be a live key on the account that buys
      // nothing. It is not the setup gate that says so — that gate reads the
      // ACCOUNT's credentials and fires whatever the session's assurance
      // (`sessions.rs`'s `verify_inside`), so no key could slip past it. The
      // enrolment component registers this browser's key itself, the moment
      // the code is confirmed.
      await signIn(address, PRINCIPAL_KIND_STEWARD, { password, registerBrowserKey: false });
    } catch (error) {
      console.error(error);
      setRefusal(`${describe(error)} ${PASSWORD_SET_NOTICE}`);
      await leaveForTheDoor(address);
      return;
    }
    setAgain('');
    setStep({ kind: 'authenticator', address });
  }

  /**
   * Step 5. Ends the setup session, then signs in with the address, the
   * password still in this component's state and the code from the app.
   *
   * **Signed out first**, which is what the old `Setup.tsx` did and for the
   * same reason: the setup session is a session, it would sit live on the
   * server until it expired, and a browser holding two sessions for one
   * account is a state nothing here needs. A failure to end it is logged and
   * not shown — the new sign-in is what this step is for, and the old row
   * expires on its own.
   *
   * **One challenge, one post.** The code goes up with the password on the
   * first post, so the server never reaches its second-factor probe and there
   * is no challenge to reuse — `signIn` is the pair of calls back to back. A
   * refused code consumes the nonce, so the next try asks for its own
   * challenge, which is exactly what calling this again does.
   */
  async function handleFinalSignIn(event: FormEvent<HTMLFormElement>, address: string) {
    event.preventDefault();
    setRefusal(null);
    setStep({ kind: 'final-sign-in', address });
    try {
      await signOut();
    } catch (error) {
      console.error(error);
    }
    try {
      await signIn(address, PRINCIPAL_KIND_STEWARD, {
        password,
        verificationCode: code,
        // The authenticator exists now, so this browser's key is worth
        // having: it is what makes the next sign-in `A1`.
        registerBrowserKey: true,
      });
    } catch (error) {
      console.error(error);
      setStep({ kind: 'second-factor', address });
      setRefusal(
        error instanceof ApiRefusal && error.retryAfterSeconds != null
          ? describe(error)
          : FIRST_RUN_CODE_REFUSED,
      );
      return;
    }
    // Nothing this flow held is needed again, and the password least of all.
    setPassword('');
    setAgain('');
    setCode('');
    onDone?.(address);
  }

  if (step.kind === 'password-set') {
    // Only ever seen when nobody wired `onPasswordSet`: App.tsx shows the
    // door on that call and this component is gone. It is here so the flow
    // has no state that ends in a screen with nothing on it.
    return (
      <div className="signin">
        <div className="signin__card">
          <h1 className="signin__title">Fathom</h1>
          <h2 className="signin__heading">{PASSWORD_SET_NOTICE}</h2>
          <p className="signin__subtitle">
            The setup token was spent, so there is nothing left to redeem. Reload this page and
            sign in at the door with {step.address} and the password you just chose.
          </p>
          {refusal && (
            <div className="signin__refusal" role="alert">
              {refusal}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (step.kind === 'second-factor' || step.kind === 'final-sign-in') {
    const address = step.address;
    return (
      <FinalSignInStage
        address={address}
        progress={progress}
        code={code}
        busy={busy}
        refusal={refusal}
        onCode={setCode}
        onSubmit={(event) => void handleFinalSignIn(event, address)}
        onUseTheDoor={onPasswordSet ? () => onPasswordSet(address) : undefined}
      />
    );
  }

  if (step.kind === 'authenticator') {
    return (
      <div className="signin">
        <div className="signin__card">
          <h1 className="signin__title">Fathom</h1>
          <p className="signin__progress">{progress}</p>
          <h2 className="signin__heading">{FIRST_RUN_STEPS[2]}</h2>
          <p className="signin__subtitle">{authenticatorStepIntro(step.address)}</p>
          {AuthenticatorEnrolment && (
            <AuthenticatorEnrolment
              address={step.address}
              onDone={() => {
                setCode('');
                setRefusal(null);
                setStep({ kind: 'second-factor', address: step.address });
              }}
            />
          )}
        </div>
      </div>
    );
  }

  if (step.kind === 'password' || step.kind === 'setting' || step.kind === 'signing-in') {
    const address = step.address;
    return (
      <PasswordStage
        address={address}
        progress={progress}
        password={password}
        again={again}
        busy={busy}
        submitLabel={
          step.kind === 'setting'
            ? 'Setting the password…'
            : step.kind === 'signing-in'
              ? 'Signing in…'
              : 'Set the password'
        }
        refusal={refusal}
        onPassword={setPassword}
        onAgain={setAgain}
        onSubmit={(event) => void handlePassword(event, address)}
      />
    );
  }

  return (
    <TokenStage
      token={token}
      progress={progress}
      busy={busy}
      submitLabel={step.kind === 'checking' ? 'Checking…' : 'Continue'}
      refusal={refusal}
      onToken={setToken}
      onSubmit={(event) => void handleToken(event)}
    />
  );
}

// ---------------------------------------------------------------------
// The steps this flow draws itself, as pure components.
//
// Drawn from their props alone, for the reason `Account.tsx`'s stages are:
// every step after the first is behind state that only a live server can
// produce, and a screen no test can render is a screen whose wording nobody
// checks. `FirstRun.render.test.ts` renders all of them.  2026-09-22.
// ---------------------------------------------------------------------

export interface TokenStageProps {
  token: string;
  progress: string;
  busy: boolean;
  submitLabel: string;
  refusal: string | null;
  onToken: (token: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

/** Step 1: the setup token, and where to find it. */
export function TokenStage({
  token,
  progress,
  busy,
  submitLabel,
  refusal,
  onToken,
  onSubmit,
}: TokenStageProps) {
  return (
    <div className="signin">
      <form className="signin__card" onSubmit={onSubmit}>
        <h1 className="signin__title">Fathom</h1>
        <p className="signin__progress">{progress}</p>
        <h2 className="signin__heading">{FIRST_RUN_STEPS[0]}</h2>
        <p className="signin__subtitle">
          This server has just been set up. Prove you are the person who installed it.
        </p>

        <div className="signin__field">
          <label className="signin__label" htmlFor="firstrun-token">
            Setup token
          </label>
          <input
            id="firstrun-token"
            className="signin__input signin__input--mono"
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={token}
            onChange={(event) => onToken(event.target.value)}
            disabled={busy}
            required
          />
          {/* The file is written twice in the life of a deployment and not
              once per restart: at the first start, when the first operator is
              created, and again if an older install is adopted by an upgrade
              (`main.rs`'s FIRST START and UPGRADE lines). An ordinary restart
              writes nothing, so the line in the file is still the live one —
              saying otherwise would send a person hunting for a file that
              never changed. */}
          <p className="signin__hint">
            The whole line, beginning <code>op_</code>, from the file named in the server&apos;s
            FIRST START or UPGRADE log line. Copy it out of the container with{' '}
            <code>
              docker compose cp server:/var/lib/fathom/bootstrap/first-operator-token
              ./first-operator-token
            </code>
            ; <code>docs/RUNNING-IT.md</code> shows the command. That file is written once, at the
            server&apos;s first start — and once more if this deployment was upgraded from an older
            build — so an ordinary restart leaves it alone. If it has been deleted, run{' '}
            <code>fathom-server recover-operator</code> on the host for a fresh one.
          </p>
        </div>

        <button className="signin__submit" type="submit" disabled={busy || token.trim().length === 0}>
          {submitLabel}
        </button>

        {refusal && (
          <div className="signin__refusal" role="alert">
            {refusal}
          </div>
        )}

        <p className="signin__note">
          Nothing is spent by this step: the token is only read, and the next screen says which
          address it belongs to before you choose anything.
        </p>
      </form>
    </div>
  );
}

export interface PasswordStageProps {
  /** The address the server named for the token. Shown, never typed. */
  address: string;
  progress: string;
  password: string;
  again: string;
  busy: boolean;
  submitLabel: string;
  refusal: string | null;
  onPassword: (password: string) => void;
  onAgain: (again: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

/** Step 2: choose a password for the address the token named. */
export function PasswordStage({
  address,
  progress,
  password,
  again,
  busy,
  submitLabel,
  refusal,
  onPassword,
  onAgain,
  onSubmit,
}: PasswordStageProps) {
  return (
    <div className="signin">
      <form className="signin__card" onSubmit={onSubmit}>
        <h1 className="signin__title">Fathom</h1>
        <p className="signin__progress">{progress}</p>
        <h2 className="signin__heading">{FIRST_RUN_STEPS[1]}</h2>
        <p className="signin__subtitle">{passwordStepIntro(address)}</p>

        {/* Shown, never typed (decision 2 step 2), and `readOnly` rather
            than absent so that a password manager has a username to file
            the new password under: the survey's own finding is that these
            tools read the fields on the page, and a password saved against
            no address is a password the person cannot be offered again. */}
        <div className="signin__field">
          <label className="signin__label" htmlFor="firstrun-address">
            Address
          </label>
          <input
            id="firstrun-address"
            className="signin__input"
            type="text"
            autoComplete="username"
            spellCheck={false}
            value={address}
            readOnly
          />
        </div>

        <div className="signin__field">
          <label className="signin__label" htmlFor="firstrun-password">
            Choose a password
          </label>
          <input
            id="firstrun-password"
            className="signin__input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => onPassword(event.target.value)}
            disabled={busy}
            required
          />
          <p className="signin__hint">
            At least fifteen characters. No composition rules and no expiry: length is the whole of
            the requirement.
          </p>
        </div>

        <div className="signin__field">
          <label className="signin__label" htmlFor="firstrun-password-again">
            Again
          </label>
          <input
            id="firstrun-password-again"
            className="signin__input"
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(event) => onAgain(event.target.value)}
            disabled={busy}
            required
          />
        </div>

        <button
          className="signin__submit"
          type="submit"
          disabled={busy || password.length === 0 || again.length === 0}
        >
          {submitLabel}
        </button>

        {refusal && (
          <div className="signin__refusal" role="alert">
            {refusal}
          </div>
        )}

        <p className="signin__note">
          The setup token is spent when this password is set. After that you sign in with the
          address, the password and a verification code.
        </p>
      </form>
    </div>
  );
}

export interface FinalSignInStageProps {
  address: string;
  progress: string;
  code: string;
  busy: boolean;
  refusal: string | null;
  onCode: (code: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /** The way out for a person whose app is not giving them a code they can
   * use: the ordinary sign-in door, which asks for exactly the same three
   * things. Absent when the caller has no door to send them to. */
  onUseTheDoor?: () => void;
}

/** Step 5: sign in with the authenticator that has just been set up. */
export function FinalSignInStage({
  address,
  progress,
  code,
  busy,
  refusal,
  onCode,
  onSubmit,
  onUseTheDoor,
}: FinalSignInStageProps) {
  return (
    <div className="signin">
      <form className="signin__card" onSubmit={onSubmit}>
        <h1 className="signin__title">Fathom</h1>
        <p className="signin__progress">{progress}</p>
        <h2 className="signin__heading">{FIRST_RUN_STEPS[4]}</h2>
        <p className="signin__subtitle">{finalSignInStepIntro(address)}</p>

        <div className="signin__field">
          <label className="signin__label" htmlFor="firstrun-code">
            Verification code
          </label>
          <input
            id="firstrun-code"
            className="signin__input signin__input--mono"
            type="text"
            inputMode="text"
            // What a password manager looks for first (ADR-0056, Bitwarden's
            // `inline-menu-field-qualification.service.ts`). `inputMode` stays
            // `text`: a numeric keypad would hide the letters a recovery code
            // is made of, and this field takes one.
            autoComplete="one-time-code"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={code}
            onChange={(event) => onCode(event.target.value)}
            disabled={busy}
            required
          />
          <p className="signin__hint">
            Six digits from your authenticator app, or one of the recovery codes you just saved.
          </p>
        </div>

        <button className="signin__submit" type="submit" disabled={busy || code.trim().length === 0}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {refusal && (
          <div className="signin__refusal" role="alert">
            {refusal}
          </div>
        )}

        {onUseTheDoor && (
          <button type="button" className="signin__switch" onClick={onUseTheDoor}>
            Sign in at the ordinary door instead
          </button>
        )}
      </form>
    </div>
  );
}
