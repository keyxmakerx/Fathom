import { useState, type FormEvent } from 'react';

import { signIn, signOut } from '../api/auth';
import { PRINCIPAL_KIND_STEWARD } from '../api/constants';
import { redeemOperatorSetup } from '../api/credentials';
import { parseToken } from '../api/enrolment';
import { ApiRefusal } from '../api/errors';
import { checkSetupToken, refreshSetupState, type SetupState } from '../api/setup';
import {
  AuthenticatorEnrolment,
  describe,
  type AuthenticatorEnrolmentStage,
} from './Account';
import '../styles/signin.css';

/**
 * The first run: one flow, five numbered steps, and then Home — which is the
 * product and not a sixth step, so nothing here counts it. While the server
 * says `pending` this flow is the only thing this client shows (ADR-0056
 * decisions 1 and 2). It replaces `Setup.tsx`, which was one long form behind
 * a link on the sign-in door — three fields and three doors for a person who
 * has just installed the thing.
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
 *   3. **Set up your authenticator app**, and 4. **Save your recovery
 *      codes** — the enrolment component on the account screen, which is the
 *      same two steps a person meets later from their own account and is not
 *      duplicated here. It says which of the two it is showing (`onStage`),
 *      so the progress line over it is the right number on both, and it is
 *      mounted `heading="none"` so that the step name this flow writes is
 *      the only heading on the screen. It drew its own as well until
 *      2026-09-22, and steps 3 and 4 each said the same thing twice.
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
 * **And the way out of step 5.** A person whose app is not giving them a code
 * they can use can take the ordinary door instead — and that button ends the
 * setup session first (`handleUseTheDoor`). It did not, and so handed the
 * person to the door still holding the `A0` session this step exists to
 * replace: they landed on Home on it and the Site entry was refused, which is
 * the state the paragraph above describes. 2026-09-22.
 *
 * The token is held in this component's own state only — never a URL, a query
 * string, a log line or `localStorage` — and cleared the moment the server
 * confirms it is spent, exactly as `Enrol.tsx` handles an invitation. The
 * password is held the same way, for the one reason step 5 needs it, and
 * cleared with it.
 */

/** The fifteen-character floor, said inline on the screen that asks for a
 * password and checked here before the round trip. The server is what
 * enforces it (`credentials.rs`'s password policy, the one refusal that
 * explains itself); this only spares the person a refusal for something the
 * screen had already told them. */
const PASSWORD_MINIMUM = 15;

/** How many steps a person is walked through, and what each is called.
 * Steps 3 and 4 are drawn by the enrolment component, not here — they are
 * named in this one list so that the progress line and the screens agree
 * about how long this is (ADR-0056 decision 2), and each name is the heading
 * that step shows, because the enrolment component's own heading is off in
 * this flow. **Five, not six.** Home is where the flow lands, not a step it
 * walks anybody through, and a person counting screens against a progress
 * line that promised six would be waiting for one that never comes: "Step 5
 * of 5" is the last thing this component says. */
export const FIRST_RUN_STEPS = [
  'Welcome',
  'Choose a password',
  'Set up your authenticator app',
  'Save your recovery codes',
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

/**
 * What the sign-in door is told when a person leaves step 5 for it.
 *
 * Both credentials exist by then — the password was set at step 2 and the
 * authenticator was confirmed at step 3 — so the door asks for exactly the
 * two things they have, and this says so rather than leaving them to guess
 * whether the code is wanted. The person who presses that button is usually
 * one whose app is not giving them a code they can use yet; nothing they did
 * was wrong, and this is not a refusal.
 */
export const AUTHENTICATOR_SET_NOTICE =
  'Your password and authenticator are set. Sign in with them.';

/**
 * The heading over the card when the server, asked again, still says this
 * deployment has not been set up.
 *
 * It should not happen: the state route answers `done` from the moment the
 * first operator has a stored password, and this flow only asks after the
 * server has said it set one. If it does happen, handing the person to the
 * sign-in door would be this client deciding, against the server's own
 * answer, that the first run is over. So the flow stays where it is and says
 * what it was told.
 *
 * **It says that, and not "your password and authenticator are set."** The
 * notice was the heading here until 2026-09-22, which told a person their
 * setup had worked on the one screen where the server was saying it had not,
 * and then gave them nothing to press. The state of the deployment is the
 * news on this screen; the sentence below carries what it means, and the
 * button beside it re-reads the state.
 */
export const SETUP_STILL_PENDING_HEADING = 'This server still reports that setup is not finished';

/** What that screen says under the heading. Names what did happen, what the
 * server is answering, and the one thing left to try. */
export const SETUP_STILL_PENDING =
  'The setup token was spent, but this server still answers that its first operator has no password, so there is no door to hand you to. Try again — and if it keeps saying this, the setup did not complete, and the server’s log is where it says why.';

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
   * This flow has handed the person to the sign-in door, and the server has
   * confirmed the deployment is set up. Show the door with `address`
   * prefilled and `notice` above it — [`PASSWORD_SET_NOTICE`] when step 2's
   * sign-in failed, [`AUTHENTICATOR_SET_NOTICE`] when the person left step 5
   * for the door themselves. Never the token step again: the token is spent
   * by either path, and blaming it would be this screen inventing a cause.
   *
   * **Only called once the state route has answered `done`** (or failed to
   * answer at all). A server still saying `pending` keeps the person here,
   * with [`SETUP_STILL_PENDING`] on the screen, because the caller's own
   * gate is that same bit and handing over against it would be this client
   * overruling the server about which screen a deployment is on.
   */
  onUseTheDoor?: (address: string, notice: string) => void;
}

/** Which of the enrolment component's two screens is up, when this flow is
 * showing it. `Account.tsx` owns them; this is what its `onStage` says, less
 * `'done'`, which ends this step rather than renumbering it. */
type EnrolmentScreen = 'setup' | 'recovery';

export type Step =
  | { kind: 'token' }
  | { kind: 'checking' }
  | { kind: 'password'; address: string }
  | { kind: 'setting'; address: string }
  | { kind: 'signing-in'; address: string }
  | { kind: 'authenticator'; address: string; screen: EnrolmentScreen }
  | { kind: 'second-factor'; address: string }
  | { kind: 'final-sign-in'; address: string }
  | { kind: 'leaving'; address: string }
  /** The end of the road for this component: the door has been asked for.
   * `handedOver` is false when the state route still said `pending`, which
   * is the one case where the caller was not called and this card is what
   * the person is left looking at. */
  | { kind: 'handed-over'; address: string; notice: string; handedOver: boolean };

/**
 * Which of [`FIRST_RUN_STEPS`] a state of this component is on.
 *
 * **The recovery codes are step 4, and were saying 3.** The enrolment
 * component draws steps 3 and 4 and this flow could not see which; it says
 * so now through `onStage`, and the number follows it, so the line and
 * [`FIRST_RUN_STEPS`] agree on every screen a person is shown. 2026-09-22.
 *
 * Exported so a runner with no DOM can check that agreement: the states this
 * maps are behind a live server, and the number over the recovery codes is
 * the thing that was wrong.
 */
export function stepNumber(step: Step): number {
  switch (step.kind) {
    case 'token':
    case 'checking':
      return 1;
    case 'password':
    case 'setting':
    case 'signing-in':
      return 2;
    case 'authenticator':
      return step.screen === 'recovery' ? 4 : 3;
    case 'second-factor':
    case 'final-sign-in':
    case 'leaving':
    case 'handed-over':
      // The last thing this flow was on. The handover card is not a step and
      // draws no progress line; the number is here so the type is total.
      return 5;
  }
}

export function FirstRun({ onDone, onUseTheDoor }: FirstRunProps) {
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'token' });
  const [refusal, setRefusal] = useState<string | null>(null);
  /** True while the "Try again" button on the still-pending card is asking
   * the state route again. Its own flag, because that card is not a step and
   * the step state is already where it is going to stay. */
  const [askingAgain, setAskingAgain] = useState(false);

  const busy =
    step.kind === 'checking' ||
    step.kind === 'setting' ||
    step.kind === 'signing-in' ||
    step.kind === 'final-sign-in' ||
    step.kind === 'leaving';
  const progress = progressLine(stepNumber(step));

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
   * The token is spent and this flow has nowhere left to send the person:
   * hand them to the sign-in door, with the sentence that says why.
   *
   * **Ask the state route again first, and act on what it says.** The
   * deployment stopped being `pending` the instant the token was spent, and
   * the answer this page read at boot is the one thing that would send the
   * person back to a token step for a token that no longer exists.
   * `refreshSetupState` re-asks with a five-second timeout, and the three
   * answers are three outcomes:
   *
   * * `done` — the door, with `notice` above it. The ordinary case.
   * * a timeout or a refusal — the door too. The server did not say this
   *   deployment is unconfigured, and the credentials in the person's hands
   *   are real whatever the route was doing.
   * * `pending` — **stay here.** It should not happen; if it does, handing
   *   over would be this client deciding against the server's own answer
   *   which screen the deployment is on, and the caller gates on that same
   *   bit. The person gets [`SETUP_STILL_PENDING`] and the console line
   *   carries the detail.
   *
   * The answer, not `undefined`, is what the caller then gates on: it is
   * called only on the first two outcomes. 2026-09-22.
   */
  async function leaveForTheDoor(address: string, notice: string) {
    let state: SetupState | null = null;
    try {
      state = await refreshSetupState();
    } catch (error) {
      console.error(error);
    }
    if (state === 'pending') {
      console.error(
        'the setup token was spent, but GET /setup/state still says pending; staying in the first-run flow',
      );
      setStep({ kind: 'handed-over', address, notice, handedOver: false });
      setRefusal(SETUP_STILL_PENDING);
      return;
    }
    setStep({ kind: 'handed-over', address, notice, handedOver: true });
    onUseTheDoor?.(address, notice);
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
      await leaveForTheDoor(address, PASSWORD_SET_NOTICE);
      return;
    }
    setAgain('');
    setStep({ kind: 'authenticator', address, screen: 'setup' });
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

  /**
   * Step 5's way out: the ordinary sign-in door, for a person whose app is
   * not giving them a code they can use.
   *
   * **The setup session is ended first.** It is still live at this point —
   * password-only, `A0`, minted at step 2 — and handing the person to the
   * door on top of it puts them on Home with a session the console's one
   * press refuses (`operators.rs` refuses `A0` at
   * `register_own_operator_key`). That was the finding: the button walked
   * away from step 5 and left behind exactly the session step 5 exists to
   * replace. A failure to sign out is logged and not shown; the door is
   * still the right screen, and the old row expires on its own.
   *
   * Then the state route is asked again, and its answer decides whether the
   * door is offered at all — see [`leaveForTheDoor`]. 2026-09-22.
   */
  async function handleUseTheDoor(address: string) {
    setRefusal(null);
    setStep({ kind: 'leaving', address });
    try {
      await signOut();
    } catch (error) {
      console.error(error);
    }
    // Nothing this flow held is needed at the door: the person types their
    // own password there, and the code is the one thing it will ask for
    // after it.
    setPassword('');
    setAgain('');
    setCode('');
    await leaveForTheDoor(address, AUTHENTICATOR_SET_NOTICE);
  }

  /**
   * The one thing the still-pending card offers: ask the state route again.
   *
   * The session is already ended and the token already spent by the time
   * that card is on screen, so re-reading the bit is the only act left that
   * can change anything — and it is the act that matters, because the answer
   * this screen is stuck on is a `pending` that should have turned over. A
   * `done` hands the person to the door on the spot ([`leaveForTheDoor`]);
   * another `pending` leaves them here with the same sentence and the same
   * button. 2026-09-22.
   */
  async function handleTryAgain(address: string, notice: string) {
    setAskingAgain(true);
    setRefusal(null);
    try {
      await leaveForTheDoor(address, notice);
    } finally {
      setAskingAgain(false);
    }
  }

  if (step.kind === 'handed-over') {
    // With a caller wired, this is seen for a moment or not at all: `App.tsx`
    // shows the door on the call and this component is gone. It is what a
    // person is left looking at in the two cases where it is not — nobody
    // wired the callback, or the server still says `pending` and the
    // handover was not made.
    const { address, notice, handedOver } = step;
    return (
      <HandedOverCard
        address={address}
        notice={notice}
        handedOver={handedOver}
        refusal={refusal}
        askingAgain={askingAgain}
        onTryAgain={() => void handleTryAgain(address, notice)}
      />
    );
  }

  if (step.kind === 'second-factor' || step.kind === 'final-sign-in' || step.kind === 'leaving') {
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
        onUseTheDoor={onUseTheDoor ? () => void handleUseTheDoor(address) : undefined}
        leaving={step.kind === 'leaving'}
      />
    );
  }

  if (step.kind === 'authenticator') {
    const address = step.address;
    return (
      <EnrolmentStage
        address={address}
        progress={progress}
        onRecovery={step.screen === 'recovery'}
        // Which of the enrolment's two screens is up, so the progress line
        // above it is right on both: the recovery codes are step 4 and were
        // saying 3 (ADR-0056 decision 2). `'done'` is not a screen —
        // `onDone` below moves this flow on.
        onStage={(stage) => {
          if (stage === 'done') return;
          setStep({ kind: 'authenticator', address, screen: stage });
        }}
        onDone={() => {
          setCode('');
          setRefusal(null);
          setStep({ kind: 'second-factor', address });
        }}
      />
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

export interface HandedOverCardProps {
  address: string;
  /** [`PASSWORD_SET_NOTICE`] or [`AUTHENTICATOR_SET_NOTICE`] — what the door
   * is being told, and the heading here when the door is where this is
   * going. */
  notice: string;
  /** False when the state route still said `pending`, which is the one case
   * where no caller was called and this card is the screen. */
  handedOver: boolean;
  refusal: string | null;
  askingAgain: boolean;
  onTryAgain: () => void;
}

/**
 * The end of this flow: the card a person is left looking at once the token
 * is spent and there is no step left to draw.
 *
 * Two states, and they are not the same screen:
 *
 * * **Handed over.** The server said `done`; the caller has been told, so
 *   with `App.tsx` wired this is on screen for a moment or not at all. The
 *   notice is the heading, because the notice is the news.
 * * **Still pending.** The server, asked again, still says this deployment
 *   has no first operator with a password. The heading is *that*
 *   ([`SETUP_STILL_PENDING_HEADING`]) and not the notice: saying "your
 *   password and authenticator are set" on the one screen where the server
 *   is answering that they are not told a person their setup had worked and
 *   then gave them nothing to press. There is one thing to press now, and it
 *   does the only act that can change this screen — read the state route
 *   again. 2026-09-22.
 */
export function HandedOverCard({
  address,
  notice,
  handedOver,
  refusal,
  askingAgain,
  onTryAgain,
}: HandedOverCardProps) {
  return (
    <div className="signin">
      <div className="signin__card">
        <h1 className="signin__title">Fathom</h1>
        <h2 className="signin__heading">{handedOver ? notice : SETUP_STILL_PENDING_HEADING}</h2>
        {/* Only where the door is in fact the next screen. With the server
            still saying `pending`, sending a person to a door this client is
            not showing them would be an instruction they cannot follow; the
            sentence in the alert below is what they have. */}
        {handedOver && (
          <p className="signin__subtitle">
            The setup token was spent, so there is nothing left to redeem. Reload this page and sign
            in at the door as {address}.
          </p>
        )}
        {refusal && (
          <div className="signin__refusal" role="alert">
            {refusal}
          </div>
        )}
        {!handedOver && (
          <button
            className="signin__submit"
            type="button"
            disabled={askingAgain}
            onClick={onTryAgain}
          >
            {askingAgain ? 'Asking the server…' : 'Try again'}
          </button>
        )}
      </div>
    </div>
  );
}

export interface EnrolmentStageProps {
  address: string;
  progress: string;
  /** True on step 4 — the recovery codes. The enrolment component below owns
   * which screen is up; this is what it said through `onStage`, and it is
   * what the heading and the progress line are drawn from. */
  onRecovery: boolean;
  onStage: (stage: AuthenticatorEnrolmentStage) => void;
  onDone: () => void;
}

/**
 * Steps 3 and 4: the card this flow draws round the account screen's
 * enrolment.
 *
 * **One heading.** This card writes the step name and the progress line; the
 * enrolment is mounted `heading="none"` so it does not write the same thing
 * again underneath. Until 2026-09-22 it did, and both steps carried two
 * `signin__heading`s — the flow's and the component's, saying the same thing
 * in two wordings. The names in [`FIRST_RUN_STEPS`] are the enrolment's own
 * headings, so nothing is lost by turning them off.
 *
 * Exported and drawn from its props, like the other stages here: a screen no
 * test can render is a screen whose wording nobody checks.
 */
export function EnrolmentStage({
  address,
  progress,
  onRecovery,
  onStage,
  onDone,
}: EnrolmentStageProps) {
  return (
    <div className="signin">
      <div className="signin__card">
        <h1 className="signin__title">Fathom</h1>
        <p className="signin__progress">{progress}</p>
        <h2 className="signin__heading">{onRecovery ? FIRST_RUN_STEPS[3] : FIRST_RUN_STEPS[2]}</h2>
        {/* Step 4 writes its own opening sentence — the codes are shown
            once, and the screen that shows them says so in its own words.
            Repeating it here would be two sentences about the same ten
            codes, one of them this file's guess at the other. */}
        {!onRecovery && <p className="signin__subtitle">{authenticatorStepIntro(address)}</p>}
        <AuthenticatorEnrolment
          address={address}
          heading="none"
          onStage={onStage}
          onDone={onDone}
        />
      </div>
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
  /** True while that way out is being taken — the setup session is being
   * ended and the state route asked again. The button says so rather than
   * looking unpressed. */
  leaving?: boolean;
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
  leaving = false,
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

        {/* While the way out below is being taken, this button is disabled
            but does not claim to be signing anybody in: the one thing
            happening then is the setup session ending. */}
        <button className="signin__submit" type="submit" disabled={busy || code.trim().length === 0}>
          {busy && !leaving ? 'Signing in…' : 'Sign in'}
        </button>

        {refusal && (
          <div className="signin__refusal" role="alert">
            {refusal}
          </div>
        )}

        {onUseTheDoor && (
          <button
            type="button"
            className="signin__switch"
            onClick={onUseTheDoor}
            disabled={busy}
          >
            {leaving ? 'Ending this session…' : 'Sign in at the ordinary door instead'}
          </button>
        )}
      </form>
    </div>
  );
}
