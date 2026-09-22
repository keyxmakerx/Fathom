import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { isSecondFactorNeeded } from '../api/auth';
import { ApiRefusal } from '../api/errors';
import {
  SecondFactorStep,
  secondFactorIntro,
  SIGN_IN_REFUSED,
  SignIn,
  VERIFICATION_CODE_HINT,
  VERIFICATION_CODE_REFUSED,
} from './SignIn';

// Render-to-string smoke tests, per `ConfigDrawer.render.test.ts`'s
// precedent -- no DOM testing library is installed, so this checks the
// markup the door produces, which is what a render-to-string pass can see.
// Effects do not run here, so the identity list (IndexedDB) is absent and
// the fields below are the whole of what a first paint shows. The second
// step is reached only through an answer from a live server, so it is drawn
// by a pure component this file renders with fixture props -- including the
// props a wrong code leaves it in. ADR-0056 decisions 3, 4 and 6. 2026-09-22.

const markup = () => renderToStaticMarkup(createElement(SignIn, {}));

describe('the sign-in door, step one (ADR-0056 decision 3)', () => {
  it('asks for the address and the password, and not for a code', () => {
    const html = markup();
    expect(html).toContain('id="signin-address"');
    expect(html).toContain('id="signin-password"');
    expect(html).toContain('type="password"');
    // The code field belongs to step two, which exists only for an account
    // the server has said holds a confirmed authenticator.
    expect(html).not.toContain('id="signin-code"');
  });

  it('no longer claims there is no password', () => {
    // The sentence this screen carried until 2026-09-21. ADR-0055 decision
    // 10 put a password behind this door; a screen still saying otherwise
    // would be wrong in the one place a person reads before typing one.
    expect(markup()).not.toMatch(/there is no password/i);
  });

  it('offers the forgotten-password door only when the caller wired one', () => {
    expect(markup()).not.toMatch(/Forgot your password/i);
    const wired = renderToStaticMarkup(createElement(SignIn, { onForgotPassword: () => {} }));
    expect(wired).toMatch(/Forgot your password\?/);
  });

  it('offers no setup door and no invitation link', () => {
    // ADR-0056 decisions 1 and 6: the server decides whether this deployment
    // is on its first run, and an invitation is redeemed at its own address.
    const html = markup();
    expect(html).not.toMatch(/first time on this server/i);
    expect(html).not.toMatch(/token the server wrote/i);
    expect(html).not.toMatch(/redeem a token/i);
  });

  it('shows a notice and a prefilled address when it was sent one', () => {
    const html = renderToStaticMarkup(
      createElement(SignIn, { initialAddress: 'owner@example.test', notice: 'Password set.' }),
    );
    expect(html).toContain('value="owner@example.test"');
    expect(html).toContain('Password set.');
  });

  it('never says "app code" or "backup code"', () => {
    // ADR-0056 decision 4.
    expect(markup()).not.toMatch(/app code/i);
    expect(markup()).not.toMatch(/backup code/i);
  });
});

describe('the sign-in door, step two', () => {
  it('is drawn by the server’s typed answer and by nothing else', () => {
    expect(isSecondFactorNeeded(new ApiRefusal(401, 'second factor needed', null))).toBe(true);
    // The uniform refusal is a 401 too, and means the opposite.
    expect(isSecondFactorNeeded(new ApiRefusal(401, 'sign-in refused', null))).toBe(false);
    expect(isSecondFactorNeeded(new ApiRefusal(403, 'second factor needed', null))).toBe(false);
    expect(isSecondFactorNeeded(new Error('second factor needed'))).toBe(false);
  });

  it('shows the address it is signing in as, so the person is not asked again', () => {
    expect(secondFactorIntro('owner@example.test')).toContain('owner@example.test');
    expect(secondFactorIntro('owner@example.test')).toMatch(/authenticator app/);
  });

  it('says both kinds of code go in the one field', () => {
    expect(VERIFICATION_CODE_HINT).toBe(
      'Six digits from your authenticator app, or one of your recovery codes.',
    );
  });
});

describe('the second step’s own markup', () => {
  const noop = () => {};
  const step = (refusal: string | null) =>
    renderToStaticMarkup(
      createElement(SecondFactorStep, {
        address: 'owner@example.test',
        code: '',
        busy: false,
        refusal,
        onCode: noop,
        onSubmit: noop,
        onStartAgain: noop,
      }),
    );

  it('asks for the code alone, and does not ask for the password again', () => {
    const html = step(null);
    expect(html).toContain('id="signin-code"');
    expect(html).toMatch(/autocomplete="one-time-code"/i);
    // `inputMode` stays text: a numeric keypad would hide the letters a
    // recovery code is made of, and this one field takes both kinds.
    expect(html).toMatch(/inputmode="text"/i);
    expect(html).toContain(VERIFICATION_CODE_HINT);
    expect(html).not.toContain('id="signin-password"');
    expect(html).not.toContain('id="signin-address"');
    // The address is said, so the person knows who they are signing in as
    // without a field to edit it in.
    expect(html).toContain('owner@example.test');
  });

  it('keeps a way back to the first step', () => {
    expect(step(null)).toMatch(/Sign in as someone else/);
  });

  it('keeps a wrong code on this step, with one sentence and the field still there', () => {
    const html = step(VERIFICATION_CODE_REFUSED);
    expect(html).toContain(VERIFICATION_CODE_REFUSED);
    expect(html).toContain('id="signin-code"');
    expect(html).toContain('role="alert"');
    // One sentence, and it names the code rather than the password: by this
    // step the password has verified once, so the code is the only new thing
    // in the request that can have been wrong.
    expect(VERIFICATION_CODE_REFUSED.split('. ').length).toBe(1);
    expect(VERIFICATION_CODE_REFUSED).toMatch(/recovery codes/);
    expect(VERIFICATION_CODE_REFUSED).not.toMatch(/app code|backup code/i);
  });

  it('never says "app code" or "backup code"', () => {
    expect(step(VERIFICATION_CODE_REFUSED)).not.toMatch(/app code/i);
    expect(step(VERIFICATION_CODE_REFUSED)).not.toMatch(/backup code/i);
  });
});

describe('what a refused sign-in says', () => {
  it('is one sentence, with no hint about setup', () => {
    // ADR-0056 decision 1 took the setup door away, so the sentence that
    // pointed at it would point at nothing.
    expect(SIGN_IN_REFUSED).toBe('Sign-in refused. Check the address and the password.');
    expect(SIGN_IN_REFUSED).not.toMatch(/setup/i);
  });
});
