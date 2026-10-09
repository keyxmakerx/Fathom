import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ApiRefusal } from '../api/errors';
import { describeRefusal, Enrol, invitationFromLocation, JoinedCode, type EnrolProps } from './Enrol';

// Render-to-string smoke tests (see `SignIn.render.test.ts`'s note), and the
// reading of the address an invitation carries. ADR-0056 decision 6:
// invitations are redeemed at `/invite#inv_…`, with the token in the fragment
// so it never reaches a request line or a log, and there is no link to this
// door under sign-in any more. 2026-09-22.

describe('the enrolment door opened by an invitation link', () => {
  it('opens with the token already in the field', () => {
    const token = `inv_${'a'.repeat(64)}`;
    const html = renderToStaticMarkup(createElement<EnrolProps>(Enrol, { initialToken: token }));
    expect(html).toContain(`value="${token}"`);
  });
});

describe('the page an invited person opens', () => {
  const token = `inv_${'c'.repeat(64)}`;
  const html = renderToStaticMarkup(createElement<EnrolProps>(Enrol, { initialToken: token }));

  it('speaks to an invited person, not to an operator redeeming a token', () => {
    expect(html).toContain('You were invited to Fathom.');
    expect(html).toContain('Invitation link');
    expect(html).not.toContain('Redeem your token.');
    const operator = renderToStaticMarkup(createElement<EnrolProps>(Enrol, { initialToken: `op_${'a'.repeat(64)}` }));
    expect(operator).toContain('Redeem your token.');
    expect(operator).not.toContain('Invitation link');
  });

  it('turns the server\u2019s terse refusal of a link into a sentence', () => {
    const said = describeRefusal(new ApiRefusal(401, 'sign-in refused', null), false, true);
    expect(said).toMatch(/^Fathom refused this sign-in\. If this link was already used/);
    expect(said).not.toContain('sign-in refused');
    expect(describeRefusal(new ApiRefusal(429, 'slow down', 30), false, true)).toContain('Try again in 30s.');
    // Other kinds of token keep the server's own words.
    expect(describeRefusal(new ApiRefusal(401, 'sign-in refused', null))).toBe('sign-in refused');
  });

  it('asks for the sign-in name that came with the link, and says it is not their email', () => {
    expect(html).toContain('Sign-in name');
    expect(html).toContain('It is not your email.');
    expect(html).toContain('read a short code to the');
    expect(html).toContain('until they do you have no');
  });

  it('shows the key-check code to read out, and what happens until a steward confirms', () => {
    const joined = renderToStaticMarkup(createElement(JoinedCode, { code: 'QDMPW1FAVF' }));
    expect(joined).toContain('QDMPW 1FAVF');
    expect(joined).toContain('read this code to them');
    expect(joined).toContain('you will see no organisation');
    expect(joined).toContain('someone else may have used your link');
  });

  it('says what to do when the code could not be read, without inventing one', () => {
    const joined = renderToStaticMarkup(createElement(JoinedCode, { code: null }));
    expect(joined).not.toContain('enrol__code');
    expect(joined).toContain('Until they confirm you');
  });
});

describe('invitationFromLocation', () => {
  it('reads the fragment on the invitation address', () => {
    const token = `inv_${'b'.repeat(64)}`;
    expect(invitationFromLocation({ pathname: '/invite', hash: `#${token}` })).toBe(token);
  });

  it('reads a trailing slash as the same address', () => {
    expect(invitationFromLocation({ pathname: '/invite/', hash: '#inv_abc' })).toBe('inv_abc');
  });

  it('is null anywhere else, and null with nothing in the fragment', () => {
    // A `#inv_…` on another page is not an invitation link, and opening a
    // door on it would be this client guessing.
    expect(invitationFromLocation({ pathname: '/', hash: '#inv_abc' })).toBeNull();
    expect(invitationFromLocation({ pathname: '/racks', hash: '#inv_abc' })).toBeNull();
    expect(invitationFromLocation({ pathname: '/invite', hash: '' })).toBeNull();
    expect(invitationFromLocation({ pathname: '/invite', hash: '#' })).toBeNull();
    expect(invitationFromLocation({})).toBeNull();
  });

  it('does not read a query string, because the token must not travel there', () => {
    // RFC 3986 §3.5: a fragment is not part of the request target. A token in
    // `?` would reach this server's own access log, which is the reason the
    // invitation puts it after the `#`.
    expect(
      invitationFromLocation({ pathname: '/invite', hash: '' } as { pathname: string; hash: string }),
    ).toBeNull();
  });
});
