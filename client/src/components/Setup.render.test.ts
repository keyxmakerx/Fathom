import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Account, AppCodeEnrolment } from './Account';
import { Setup } from './Setup';

// Render-to-string smoke tests (see `SignIn.render.test.ts`'s note).

describe('the first operator’s setup door', () => {
  const html = renderToStaticMarkup(createElement(Setup, {}));

  it('asks for the token, the address and a password twice', () => {
    expect(html).toContain('id="setup-token"');
    expect(html).toContain('id="setup-address"');
    expect(html).toContain('id="setup-password"');
    expect(html).toContain('id="setup-password-again"');
  });

  it('names the variable the address comes from rather than guessing it', () => {
    expect(html).toContain('FATHOM_OPERATOR_NOTICE_ADDRESS');
  });

  it('says the token works once', () => {
    expect(html).toMatch(/works once/i);
  });

  it('states the fifteen-character floor where the password is chosen', () => {
    expect(html).toMatch(/at least fifteen characters/i);
  });
});

describe('the account screen', () => {
  it('for a person who came here themselves, offers the password and the app code', () => {
    const html = renderToStaticMarkup(createElement(Account, { address: 'owner@example.test' }));
    expect(html).toContain('id="account-password"');
    expect(html).toMatch(/app code/i);
    expect(html).toContain('owner@example.test');
  });

  it('for a person the app-code refusal sent here, leads with why and drops the password form', () => {
    const html = renderToStaticMarkup(
      createElement(Account, { address: 'owner@example.test', purpose: 'app-code' }),
    );
    expect(html).toMatch(/holds the operator custody/i);
    expect(html).not.toContain('id="account-password"');
  });
});

describe('the app-code enrolment', () => {
  it('starts closed, with the button that draws a secret', () => {
    const html = renderToStaticMarkup(createElement(AppCodeEnrolment, { address: 'owner@example.test' }));
    expect(html).toMatch(/Enrol an app code/);
    // Nothing is drawn before it is asked for: `POST /credentials/totp/enrol`
    // is one per session, and a screen that spent it on being rendered would
    // spend it for a person who only opened the page.
    expect(html).not.toContain('data-testid="totp-secret"');
  });
});
