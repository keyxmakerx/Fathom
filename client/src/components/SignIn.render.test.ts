import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SignIn } from './SignIn';

// Render-to-string smoke tests, per `ConfigDrawer.render.test.ts`'s
// precedent -- no DOM testing library is installed, so this checks the
// markup the door produces, which is what a render-to-string pass can see.
// Effects do not run here, so the identity list (IndexedDB) is absent and
// the fields below are the whole of what a first paint shows.

const markup = () => renderToStaticMarkup(createElement(SignIn, {}));

describe('the sign-in door, ADR-0055 decision 10', () => {
  it('asks for the address, the password and the app code', () => {
    const html = markup();
    expect(html).toContain('id="signin-address"');
    expect(html).toContain('id="signin-password"');
    expect(html).toContain('id="signin-code"');
    expect(html).toContain('type="password"');
  });

  it('says on the code field that a backup code goes in the same box', () => {
    // The person reaching for a backup code has already lost their phone.
    // `sessions.rs`'s `check_second_factor` takes both in the one field, so
    // the screen says so rather than leaving it to be discovered.
    expect(markup()).toMatch(/backup code/i);
  });

  it('no longer claims there is no password', () => {
    // The sentence this screen carried until 2026-09-21. Decision 10 put a
    // password behind this door; a screen still saying otherwise would be
    // wrong in the one place a person reads before typing one.
    expect(markup()).not.toMatch(/there is no password/i);
  });

  it('offers the forgotten-password door only when the caller wired one', () => {
    expect(markup()).not.toMatch(/Forgotten your password/i);
    const wired = renderToStaticMarkup(createElement(SignIn, { onForgotPassword: () => {} }));
    expect(wired).toMatch(/Forgotten your password/i);
  });

  it('offers the first-operator setup door only when the caller wired one', () => {
    const wired = renderToStaticMarkup(createElement(SignIn, { onFirstOperatorSetup: () => {} }));
    expect(wired).toMatch(/token the server wrote at first start/i);
  });

  it('shows a notice and a prefilled address when it was sent one', () => {
    const html = renderToStaticMarkup(
      createElement(SignIn, { initialAddress: 'owner@example.test', notice: 'Password set.' }),
    );
    expect(html).toContain('value="owner@example.test"');
    expect(html).toContain('Password set.');
  });
});
