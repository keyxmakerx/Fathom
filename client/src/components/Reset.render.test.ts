import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Reset, RESET_ANSWER, tokenFromLocation } from './Reset';

// Render-to-string smoke tests (see `SignIn.render.test.ts`'s note).

describe('forgot my password', () => {
  const html = renderToStaticMarkup(createElement(Reset, {}));

  it('asks for the address and nothing else', () => {
    expect(html).toContain('id="reset-address"');
    expect(html).not.toContain('id="reset-password"');
  });

  it('carries the one answer every address gets', () => {
    // ADR-0055 decision 7 and `request_reset_handler`: 200 for every
    // address, known or not. The screen has to say the same thing for every
    // address or it undoes the route.
    expect(html).toContain('same whatever was typed');
  });

  it('does not promise mail this build cannot send', () => {
    expect(RESET_ANSWER).toMatch(/once this site’s mail is set up/);
    expect(RESET_ANSWER).toMatch(/Nothing is sent before then/);
  });
});

describe('the screen a reset link lands on', () => {
  const html = renderToStaticMarkup(createElement(Reset, { initialToken: 'a'.repeat(64) }));

  it('opens at the second step with the token already in the field', () => {
    expect(html).toContain('id="reset-token"');
    expect(html).toContain('id="reset-password"');
    expect(html).toContain('id="reset-password-again"');
    expect(html).toContain('value="' + 'a'.repeat(64) + '"');
  });

  it('says a reset does not sign anybody in and does not skip the second factor', () => {
    expect(html).toMatch(/does not sign you in/i);
    expect(html).toMatch(/verification code/i);
  });
});

describe('tokenFromLocation', () => {
  it('reads the fragment, which does not travel in the request line', () => {
    expect(tokenFromLocation({ hash: '#reset=abc123', search: '' })).toBe('abc123');
  });

  it('reads the query string too, since the mailed link’s shape is not settled', () => {
    expect(tokenFromLocation({ search: '?reset=def456', hash: '' })).toBe('def456');
  });

  it('prefers the fragment when both are present', () => {
    expect(tokenFromLocation({ hash: '#reset=fragment', search: '?reset=query' })).toBe('fragment');
  });

  it('is null for an ordinary visit, an empty value, and another parameter', () => {
    expect(tokenFromLocation({ hash: '', search: '' })).toBeNull();
    expect(tokenFromLocation({ hash: '#reset=', search: '' })).toBeNull();
    expect(tokenFromLocation({ search: '?other=1', hash: '' })).toBeNull();
    expect(tokenFromLocation({})).toBeNull();
  });
});
