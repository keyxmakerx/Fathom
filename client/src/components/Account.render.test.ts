import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  Account,
  AuthenticatorEnrolment,
  AuthenticatorSetupStage,
  RecoveryCodesStage,
  recoveryCodeFile,
} from './Account';

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

  it('asks for the current password too (ADR-0057 decision 3)', () => {
    const html = renderToStaticMarkup(createElement(Account, { address: 'owner@example.test' }));
    expect(html).toContain('id="account-current-password"');
    expect(html).toContain('autoComplete="current-password"');
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

  it('asks for neither a password nor a code on a first enrolment', () => {
    expect(closed).not.toContain('id="authenticator-reauth-password"');
    expect(closed).not.toContain('id="authenticator-reauth-code"');
  });

  it('asks for the current password and a current code before replacing a confirmed one (ADR-0057 decision 3)', () => {
    const html = renderToStaticMarkup(
      createElement(AuthenticatorEnrolment, {
        address: 'owner@example.test',
        onDone: () => {},
        requiresReauth: true,
      }),
    );
    expect(html).toContain('id="authenticator-reauth-password"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain('id="authenticator-reauth-code"');
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toMatch(/Replace the authenticator app/);
  });
});

describe('the authenticator setup stage, rendered', () => {
  // The two screens ADR-0056 rewrote had no test that rendered them, because
  // rendering them through the stateful component meant spending a real
  // enrolment on the server. They are prop-driven components now, so the
  // fixture is the enrolment.
  const html = renderToStaticMarkup(
    createElement(AuthenticatorSetupStage, {
      address: 'owner@example.test',
      secretBase32: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      otpauthUri:
        'otpauth://totp/Fathom:owner@example.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Fathom&algorithm=SHA1&digits=6&period=30',
      code: '',
      onCodeChange: () => {},
      onSubmit: () => {},
      refusal: null,
      busy: false,
    }),
  );

  it('draws the QR code as inline SVG, with nothing the policy has to allow', () => {
    // ADR-0056 decisions 5 and 7: a password manager reads the secret only
    // out of a picture, and the picture must not need `img-src` or an inline
    // style to draw.
    expect(html).toContain('data-testid="qr"');
    expect(html).toContain('<svg');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('data:');
    expect(html).not.toContain('style=');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('data-testid="qr-missing"');
  });

  it('shows the setup key and the otpauth link beside it', () => {
    expect(html).toContain('data-testid="totp-secret"');
    expect(html).toContain('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
    expect(html).toContain('data-testid="totp-uri"');
    expect(html).toMatch(/setup key/);
    expect(html).toContain('owner@example.test');
  });

  it('asks for a verification code in a field a password manager can find', () => {
    expect(html).toContain('id="account-code"');
    expect(html).toContain('for="account-code"');
    // Bitwarden qualifies this field by `autocomplete` first (ADR-0056).
    // Case-insensitive: this renderer writes the attribute the way the JSX
    // prop is spelled, and HTML attribute names are case-insensitive, so
    // what reaches a browser is `autocomplete` either way.
    expect(html).toMatch(/autoComplete="one-time-code"/i);
    expect(html).toMatch(/Verification code/);
  });

  it('shows the sentence it is given and nothing when there is none', () => {
    expect(html).not.toContain('role="alert"');
    const refused = renderToStaticMarkup(
      createElement(AuthenticatorSetupStage, {
        address: 'owner@example.test',
        secretBase32: 'JBSWY3DPEHPK3PXP',
        otpauthUri: 'otpauth://totp/Fathom:owner@example.test?secret=JBSWY3DPEHPK3PXP',
        code: '123456',
        onCodeChange: () => {},
        onSubmit: () => {},
        refusal: 'That code was refused.',
        busy: true,
      }),
    );
    expect(refused).toContain('role="alert"');
    expect(refused).toContain('That code was refused.');
    expect(refused).toMatch(/Checking/);
  });

  it('says nothing about an "app code" or a "backup code"', () => {
    expect(html.toLowerCase()).not.toContain('app code');
    expect(html.toLowerCase()).not.toContain('backup code');
  });
});

describe('the recovery-codes stage, rendered', () => {
  const codes = ['aaaa-bbbb', 'cccc-dddd', 'eeee-ffff'];
  const render = (saved: boolean) =>
    renderToStaticMarkup(
      createElement(RecoveryCodesStage, {
        address: 'owner@example.test',
        codes,
        saved,
        onSavedChange: () => {},
        onDone: () => {},
      }),
    );

  it('shows every code once, and names the account they open', () => {
    const html = render(false);
    for (const code of codes) expect(html).toContain(code);
    expect(html).toContain('owner@example.test');
    expect(html).toMatch(/shown now and never again/);
  });

  it('keeps Done shut until the person says they have saved them', () => {
    // The server keeps only hashes, so this screen is the only time these
    // exist. The gate is a control that has to be pressed.
    const unsaved = render(false);
    expect(unsaved).toContain('I have saved these.');
    expect(unsaved).toContain('aria-checked="false"');
    expect(unsaved).toMatch(/<button[^>]*disabled[^>]*>Done<\/button>/);

    const saved = render(true);
    expect(saved).toContain('aria-checked="true"');
    expect(saved).toMatch(/<button[^>]*>Done<\/button>/);
    expect(saved).not.toMatch(/<button[^>]*disabled[^>]*>Done<\/button>/);
  });

  it('offers both ways of keeping them', () => {
    expect(render(false)).toMatch(/Copy all/);
    expect(render(false)).toMatch(/Download as text file/);
  });

  it('calls them recovery codes and nothing else', () => {
    const html = render(false).toLowerCase();
    expect(html).toContain('recovery codes');
    expect(html).not.toContain('backup code');
    expect(html).not.toContain('app code');
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
