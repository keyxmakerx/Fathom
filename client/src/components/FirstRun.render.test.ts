import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import * as AccountModule from './Account';
import {
  authenticatorStepIntro,
  FinalSignInStage,
  finalSignInStepIntro,
  FIRST_RUN_CODE_REFUSED,
  FIRST_RUN_STEPS,
  FirstRun,
  PASSWORD_SET_NOTICE,
  PasswordStage,
  passwordStepIntro,
  progressLine,
  SETUP_TOKEN_REFUSED,
  TokenStage,
} from './FirstRun';

// Render-to-string smoke tests, per `ConfigDrawer.render.test.ts`'s
// precedent -- no DOM testing library is installed, so this checks the markup
// the flow produces, which is what a render-to-string pass can see.
//
// **Every step is rendered here, 1 to 5.** Steps 2 and 5 are behind state a
// live server produces, so `FirstRun.tsx` draws them with pure components
// this file renders directly with fixture props; steps 3 and 4 belong to the
// account screen's enrolment, and this file renders ITS stages the same way.
// The rule the last block enforces -- no "app code", no "backup code",
// anywhere a person reads -- is worth nothing if it is only checked on the
// one screen a bare render happens to reach. ADR-0056 decisions 2 and 4.
// 2026-09-22.

const ADDRESS = 'owner@example.test';
const noop = () => {};

const html = renderToStaticMarkup(createElement(FirstRun, {}));

const stepOne = renderToStaticMarkup(
  createElement(TokenStage, {
    token: 'op_xxx',
    progress: progressLine(1),
    busy: false,
    submitLabel: 'Continue',
    refusal: SETUP_TOKEN_REFUSED,
    onToken: noop,
    onSubmit: noop,
  }),
);

const stepTwo = renderToStaticMarkup(
  createElement(PasswordStage, {
    address: ADDRESS,
    progress: progressLine(2),
    password: '',
    again: '',
    busy: false,
    submitLabel: 'Set the password',
    refusal: 'The two passwords are not the same.',
    onPassword: noop,
    onAgain: noop,
    onSubmit: noop,
  }),
);

const stepFive = renderToStaticMarkup(
  createElement(FinalSignInStage, {
    address: ADDRESS,
    progress: progressLine(5),
    code: '',
    busy: false,
    refusal: FIRST_RUN_CODE_REFUSED,
    onCode: noop,
    onSubmit: noop,
    onUseTheDoor: noop,
  }),
);

// ---------------------------------------------------------------------
// Steps 3 and 4 are the account screen's, and this flow shows them whole.
//
// The other client stream exports them as pure stages for exactly this
// (`AuthenticatorSetupStage`, `RecoveryCodesStage`); until both halves are
// merged the enrolment component itself is what is there, so the first
// screen it draws stands in. Either way something a person reads is rendered
// and checked, which is the point -- a step nothing renders is a step whose
// wording nobody checks.
// ---------------------------------------------------------------------
type StageProps = Record<string, unknown>;
type Stages = Partial<{
  AuthenticatorSetupStage: ComponentType<StageProps>;
  RecoveryCodesStage: ComponentType<StageProps>;
  AuthenticatorEnrolment: ComponentType<StageProps>;
  AppCodeEnrolment: ComponentType<StageProps>;
  recoveryCodeFile: (address: string, codes: readonly string[]) => string;
}>;
const account = AccountModule as unknown as Stages;

const ENROLMENT = {
  secretBase32: 'JBSWY3DPEHPK3PXP',
  otpauthUri: `otpauth://totp/Fathom:${ADDRESS}?secret=JBSWY3DPEHPK3PXP&issuer=Fathom`,
};
const RECOVERY_CODES = [
  'aaaa-bbbb',
  'cccc-dddd',
  'eeee-ffff',
  'gggg-hhhh',
  'iiii-jjjj',
  'kkkk-llll',
  'mmmm-nnnn',
  'oooo-pppp',
  'qqqq-rrrr',
  'ssss-tttt',
];

const setupStage = account.AuthenticatorSetupStage ?? null;
const recoveryStage = account.RecoveryCodesStage ?? null;
const enrolment = account.AuthenticatorEnrolment ?? account.AppCodeEnrolment ?? null;

/** A superset of the props either shape of the stage could want. React
 * ignores what a component does not read, so this survives the rename
 * landing without this file having to guess the signature exactly. */
const setupStageProps: StageProps = {
  address: ADDRESS,
  enrolment: ENROLMENT,
  secretBase32: ENROLMENT.secretBase32,
  otpauthUri: ENROLMENT.otpauthUri,
  code: '',
  busy: false,
  confirming: false,
  copied: null,
  refusal: null,
  onCode: noop,
  onSubmit: noop,
  onCopy: noop,
};
const recoveryStageProps: StageProps = {
  address: ADDRESS,
  codes: RECOVERY_CODES,
  saved: false,
  copied: null,
  onSaved: noop,
  onToggleSaved: noop,
  onCopy: noop,
  onDownload: noop,
  onDone: noop,
};

const stepThree = setupStage
  ? renderToStaticMarkup(createElement(setupStage, setupStageProps))
  : enrolment
    ? renderToStaticMarkup(createElement(enrolment, { address: ADDRESS, onDone: noop }))
    : '';
const stepFour = recoveryStage
  ? renderToStaticMarkup(createElement(recoveryStage, recoveryStageProps))
  : (account.recoveryCodeFile?.(ADDRESS, RECOVERY_CODES) ?? '');

describe('the first run, step 1', () => {
  it('opens on the token and asks for nothing else', () => {
    expect(html).toContain('id="firstrun-token"');
    // The address is the server's to name (decision 2 step 1): nothing is
    // typed here, which is the owner's "give an error if the email doesn't
    // match" met by removing the field. Step 2 shows it, read-only.
    expect(html).not.toContain('id="firstrun-address"');
    expect(html).not.toContain('id="firstrun-password"');
  });

  it('says where the token is and how to copy it out', () => {
    expect(html).toMatch(/docker compose cp/);
    expect(html).toMatch(/first-operator-token/);
  });

  it('says the file is written at the first start, not on every restart', () => {
    // `main.rs` writes it in two places and neither is an ordinary restart:
    // FIRST START, when the first operator is created, and UPGRADE, when an
    // older install is adopted. A hint that told a person to copy it again
    // after the latest restart would send them looking for a change that
    // never happened.
    expect(html).toMatch(/written once, at the server(&#x27;|’)s first start/);
    expect(html).toMatch(/an ordinary restart leaves it alone/);
    expect(html).not.toMatch(/every restart/i);
    // And what to do when the file is gone, which is the state that hint was
    // reaching for.
    expect(html).toMatch(/fathom-server recover-operator/);
  });

  it('leads with the ADR’s own welcome, and counts the steps', () => {
    expect(html).toContain(
      'This server has just been set up. Prove you are the person who installed it.',
    );
    expect(html).toContain('Step 1 of 5');
  });

  it('says the first step spends nothing', () => {
    // `POST /enrolment/operator/setup/check` is a read: no chain entry, no
    // token spent. A person who mistypes the line loses nothing by it.
    expect(html).toMatch(/Nothing is spent by this step/);
  });

  it('offers no other door', () => {
    // ADR-0056 decision 2: while the deployment is pending this is the whole
    // of the client. No sign-in link, no invitation, no reset.
    expect(html).not.toMatch(/sign in/i);
    expect(html).not.toMatch(/invit/i);
    expect(html).not.toMatch(/forgot/i);
  });

  it('shows a refusal where the person is looking, without losing the field', () => {
    expect(stepOne).toContain(SETUP_TOKEN_REFUSED);
    expect(stepOne).toContain('id="firstrun-token"');
  });
});

describe('the steps and the progress line', () => {
  it('is five steps, ending in a sign-in with the new authenticator', () => {
    expect(FIRST_RUN_STEPS).toEqual([
      'Welcome',
      'Choose a password',
      'Set up your authenticator app',
      'Recovery codes',
      'Sign in with your new authenticator',
    ]);
    expect(progressLine(2)).toBe('Step 2 of 5');
    expect(progressLine(5)).toBe('Step 5 of 5');
  });
});

describe('step 2, choose a password', () => {
  const intro = passwordStepIntro(ADDRESS);

  it('names the address the server gave and does not ask for it', () => {
    expect(intro).toContain(ADDRESS);
    expect(intro).toMatch(/nothing to type and nothing to get wrong/);
  });

  it('draws the address read-only beside the two password fields', () => {
    expect(stepTwo).toContain(intro);
    expect(stepTwo).toContain('id="firstrun-address"');
    expect(stepTwo).toMatch(/readonly/i);
    expect(stepTwo).toMatch(/autocomplete="username"/i);
    expect(stepTwo).toContain('id="firstrun-password"');
    expect(stepTwo).toContain('id="firstrun-password-again"');
    expect(stepTwo).toMatch(/At least fifteen characters/);
    expect(stepTwo).toContain('Step 2 of 5');
  });
});

describe('step 3, the authenticator app', () => {
  const intro = authenticatorStepIntro(ADDRESS);

  it('says why this account needs a second factor, and what is left', () => {
    expect(intro).toContain(ADDRESS);
    expect(intro).toMatch(/second factor/);
    expect(intro).toMatch(/recovery codes/i);
    // Step 5 is named here, so nobody meets it as a surprise.
    expect(intro).toMatch(/one last sign-in/i);
  });

  it('renders the enrolment the account screen owns', () => {
    expect(stepThree).not.toBe('');
    expect(stepThree.toLowerCase()).toContain('authenticator app');
    if (setupStage) {
      // The stage with a secret in hand: the QR code, the setup key beside
      // it, and the one field a password manager is looking for.
      expect(stepThree).toContain(ENROLMENT.secretBase32);
      expect(stepThree.toLowerCase()).toContain('setup key');
      expect(stepThree).toMatch(/autocomplete="one-time-code"/i);
      expect(stepThree).toMatch(/verification code/i);
    }
  });
});

describe('step 4, the recovery codes', () => {
  it('shows the codes and says they are shown once', () => {
    expect(stepFour).not.toBe('');
    expect(stepFour).toContain('aaaa-bbbb');
    expect(stepFour).toContain('ssss-tttt');
    expect(stepFour.toLowerCase()).toMatch(/once/);
  });
});

describe('step 5, sign in with the new authenticator', () => {
  const intro = finalSignInStepIntro(ADDRESS);

  it('says why a person who has just set all this up is asked to sign in', () => {
    // The session the flow has been using was minted from a password alone,
    // before the app existed, and `operators.rs` refuses `A0` at the one
    // press that opens the console. This step is what makes Home's Site
    // entry work on the first press instead of taking itself away.
    expect(intro).toContain(ADDRESS);
    expect(intro).toMatch(/before the app existed/);
    expect(intro).toMatch(/never proved the second factor/);
  });

  it('asks for the code and nothing else', () => {
    expect(stepFive).toContain('id="firstrun-code"');
    expect(stepFive).toMatch(/autocomplete="one-time-code"/i);
    // Neither the address nor the password is asked for again: both are
    // still in the flow's own state, and retyping them is not a step.
    expect(stepFive).not.toContain('id="firstrun-password"');
    expect(stepFive).not.toContain('id="firstrun-address"');
    expect(stepFive).toContain('Step 5 of 5');
    expect(stepFive).toContain(intro);
  });

  it('takes a recovery code in the same field, and says so', () => {
    expect(stepFive).toMatch(/or one of the recovery codes you just saved/i);
    // `inputMode` stays text: a numeric keypad would hide the letters a
    // recovery code is made of.
    expect(stepFive).toMatch(/inputmode="text"/i);
  });

  it('keeps a refused code on this step, in one sentence', () => {
    expect(stepFive).toContain(FIRST_RUN_CODE_REFUSED);
    expect(stepFive).toContain('id="firstrun-code"');
    expect(FIRST_RUN_CODE_REFUSED.split('. ').length).toBe(1);
  });
});

describe('the sentence a refused setup token gets', () => {
  it('is the ADR’s, and names the token file rather than a cause', () => {
    // Wrong, spent, expired and malformed are one answer on purpose.
    expect(SETUP_TOKEN_REFUSED).toBe(
      'Setup token is missing or invalid. Find the current token in the server’s token file.',
    );
  });
});

describe('the sentence a spent token and a failed sign-in get', () => {
  it('states the fact and points at the door, and blames nothing', () => {
    // The token is gone by then, so the step that asks for one must never
    // come back: there is nothing left for a person to type into it.
    expect(PASSWORD_SET_NOTICE).toBe('Your password is set. Sign in with it.');
    expect(PASSWORD_SET_NOTICE.toLowerCase()).not.toContain('token');
  });
});

describe('the words this flow uses', () => {
  it('never says "app code" or "backup code" where a person reads', () => {
    // ADR-0056 decision 4, checked on every step's markup and on the copy
    // that is exported as sentences rather than markup.
    for (const text of [
      html,
      stepOne,
      stepTwo,
      stepThree,
      stepFour,
      stepFive,
      passwordStepIntro(ADDRESS),
      authenticatorStepIntro(ADDRESS),
      finalSignInStepIntro(ADDRESS),
      SETUP_TOKEN_REFUSED,
      PASSWORD_SET_NOTICE,
      FIRST_RUN_CODE_REFUSED,
      ...FIRST_RUN_STEPS,
    ]) {
      expect(text).not.toMatch(/app code/i);
      expect(text).not.toMatch(/backup code/i);
    }
  });
});
