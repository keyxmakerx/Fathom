import { useState, type ComponentType, type FormEvent } from 'react';

import { signIn } from '../api/auth';
import { PRINCIPAL_KIND_STEWARD } from '../api/constants';
import { redeemOperatorSetup } from '../api/credentials';
import { parseToken } from '../api/enrolment';
import { ApiRefusal } from '../api/errors';
import { checkSetupToken } from '../api/setup';
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
 *      into a session. Here.
 *   3. **Set up your authenticator app**, and 4. **recovery codes**, and
 *      5. **done** — the enrolment component on the account screen, which is
 *      the same three steps a person meets later from their own account and
 *      is not duplicated here.
 *
 * The token is held in this component's own state only — never a URL, a query
 * string, a log line or `localStorage` — and cleared the moment the server
 * confirms it is spent, exactly as `Enrol.tsx` handles an invitation.
 */

/**
 * Step 3's screen, from the account screen's own module.
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
 * Steps 4 and 5 are drawn by the enrolment component, not here — they are
 * named in this one list so that the progress line and the ADR agree about
 * how long this is (ADR-0056 decision 2). */
export const FIRST_RUN_STEPS = [
  'Welcome',
  'Choose a password',
  'Set up your authenticator app',
  'Recovery codes',
  'Done',
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
    'factor before it can do anything else. Your recovery codes come after this, and then you are done.'
  );
}

/** What a refused setup token says, ADR-0056 decision 2 step 1 verbatim. The
 * server answers one sentence for wrong, spent, expired and malformed alike,
 * written for the audit trail; this is the one written for the person, and it
 * does not guess which of the four it was. */
export const SETUP_TOKEN_REFUSED =
  'Setup token is missing or invalid. Find the current token in the server’s token file.';

export interface FirstRunProps {
  /**
   * The flow is finished: the password is set, the authenticator app is
   * confirmed and the recovery codes are saved.
   *
   * The session made at step 2 is still the one in hand. It was minted before
   * the authenticator existed, so its assurance is `A0` and
   * `register_own_operator_key` refuses `A0` whatever the account has
   * enrolled since — the operator console asks for a fresh sign-in. Every
   * other route takes it the moment the code is confirmed, because the setup
   * gate reads the account's live credentials on each request
   * (`sessions.rs`'s `verify_inside` (5)), so this lands on Home rather than
   * back at the door (ADR-0056 decision 2 step 5).
   */
  onDone?: (address: string) => void;
}

type Step =
  | { kind: 'token' }
  | { kind: 'checking' }
  | { kind: 'password'; address: string }
  | { kind: 'setting'; address: string }
  | { kind: 'signing-in'; address: string }
  | { kind: 'authenticator'; address: string };

const STEP_NUMBER: Record<Step['kind'], number> = {
  token: 1,
  checking: 1,
  password: 2,
  setting: 2,
  'signing-in': 2,
  authenticator: 3,
};

export function FirstRun({ onDone }: FirstRunProps) {
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'token' });
  const [refusal, setRefusal] = useState<string | null>(null);

  const busy = step.kind === 'checking' || step.kind === 'setting' || step.kind === 'signing-in';
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
      // **No browser key yet.** The authenticator is not enrolled, so a key
      // here would make this session `A1` and slip past the very gate that
      // keeps an unfinished operator in this flow — see `../api/auth.ts`.
      await signIn(address, PRINCIPAL_KIND_STEWARD, { password, registerBrowserKey: false });
    } catch (error) {
      console.error(error);
      setStep({ kind: 'password', address });
      setRefusal(`${describe(error)} The password is set; sign in with it at the ordinary door.`);
      return;
    }
    setPassword('');
    setAgain('');
    setStep({ kind: 'authenticator', address });
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
            <AuthenticatorEnrolment address={step.address} onDone={() => onDone?.(step.address)} />
          )}
        </div>
      </div>
    );
  }

  if (step.kind === 'password' || step.kind === 'setting' || step.kind === 'signing-in') {
    const address = step.address;
    return (
      <div className="signin">
        <form className="signin__card" onSubmit={(event) => void handlePassword(event, address)}>
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
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              required
            />
            <p className="signin__hint">
              At least fifteen characters. No composition rules and no expiry: length is the whole
              of the requirement.
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
              onChange={(event) => setAgain(event.target.value)}
              disabled={busy}
              required
            />
          </div>

          <button
            className="signin__submit"
            type="submit"
            disabled={busy || password.length === 0 || again.length === 0}
          >
            {step.kind === 'setting'
              ? 'Setting the password…'
              : step.kind === 'signing-in'
                ? 'Signing in…'
                : 'Set the password'}
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

  return (
    <div className="signin">
      <form className="signin__card" onSubmit={(event) => void handleToken(event)}>
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
            onChange={(event) => setToken(event.target.value)}
            disabled={busy}
            required
          />
          <p className="signin__hint">
            The whole line, beginning <code>op_</code>, from the file named in the server&apos;s
            FIRST START or UPGRADE log line. Copy it out of the container with{' '}
            <code>
              docker compose cp server:/var/lib/fathom/bootstrap/first-operator-token
              ./first-operator-token
            </code>
            ; <code>docs/RUNNING-IT.md</code> shows the command. Every restart that writes that file
            replaces the old one, so copy it again after the latest restart.
          </p>
        </div>

        <button
          className="signin__submit"
          type="submit"
          disabled={busy || token.trim().length === 0}
        >
          {step.kind === 'checking' ? 'Checking…' : 'Continue'}
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
