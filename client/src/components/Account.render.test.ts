import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Account, AppCodeEnrolment, AuthenticatorEnrolment, recoveryCodeFile } from './Account';

// Render-to-string smoke tests (see `SignIn.render.test.ts`'s note). Written
// 2026-09-22 for ADR-0056 decisions 4 and 5; the account-screen assertions
// that used to live in `Setup.render.test.ts` are here now, beside the
// component they are about.

describe('the account screen', () => {
  it('for a person who came here themselves, offers the password and the authenticator app', () => {
    const html = renderToStaticMarkup(createElement(Account, { address: 'owner@example.test' }));
    expect(html).toContain('id="account-password"');
    expect(html).toMatch(/authenticator app/i);
    expect(html).toContain('owner@example.test');
  });

  it('for a person the server sent here, leads with why and drops the password form', () => {
    const html = renderToStaticMarkup(
      createElement(Account, { address: 'owner@example.test', purpose: 'app-code' }),
    );
    expect(html).toMatch(/holds the operator custody/i);
    expect(html).not.toContain('id="account-password"');
  });

  it('says nothing to a person about an "app code" or a "backup code"', () => {
    // ADR-0056 decision 4. Case-insensitive, because the heading is
    // uppercased by the stylesheet and not by the string.
    const html = renderToStaticMarkup(
      createElement(Account, { address: 'owner@example.test' }),
    ).toLowerCase();
    expect(html).not.toContain('app code');
    expect(html).not.toContain('backup code');
  });
});

describe('the authenticator enrolment', () => {
  const closed = renderToStaticMarkup(
    createElement(AuthenticatorEnrolment, { address: 'owner@example.test', onDone: () => {} }),
  );

  it('starts closed, with the button that draws a secret', () => {
    expect(closed).toMatch(/Set up an authenticator app/);
    // Nothing is drawn before it is asked for: `POST /credentials/totp/enrol`
    // is one per session, and a screen that spent it on being rendered would
    // spend it for a person who only opened the page.
    expect(closed).not.toContain('data-testid="totp-secret"');
    expect(closed).not.toContain('data-testid="qr"');
  });

  it('is still exported under its old name while the other stream lands', () => {
    expect(AppCodeEnrolment).toBe(AuthenticatorEnrolment);
  });
});

describe('the recovery-code file', () => {
  it('names the server account the codes open, and carries no secret but the codes', () => {
    const file = recoveryCodeFile('owner@example.test', ['aaaa-bbbb', 'cccc-dddd']);
    expect(file).toContain('owner@example.test');
    expect(file).toContain('aaaa-bbbb');
    expect(file).toContain('cccc-dddd');
    expect(file).toMatch(/works once/);
    expect(file.toLowerCase()).not.toContain('backup code');
  });
});
