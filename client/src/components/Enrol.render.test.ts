import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Enrol, invitationFromLocation, type EnrolProps } from './Enrol';

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
