import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { InvitationHandover } from './InvitationHandover';
import { invitationAddress } from './invitationAddress';

// ADR-0056 decision 6: an invitation is redeemed at `/invite#<token>` and the
// console shows that address next to the token it minted. The board used to
// show the token alone, which left the operator to know an address nothing on
// the page told them.

describe('the address an invitation is redeemed at', () => {
  it('puts the token in the fragment, on the host this page came from', () => {
    expect(invitationAddress('https://fathom.example.test', 'inv_a1b2')).toBe(
      'https://fathom.example.test/invite#inv_a1b2',
    );
  });

  it('keeps a port, and does not double a slash', () => {
    expect(invitationAddress('https://fathom.example.test:8443', 'org_ff')).toBe(
      'https://fathom.example.test:8443/invite#org_ff',
    );
    expect(invitationAddress('https://fathom.example.test/', 'inv_ff')).toBe(
      'https://fathom.example.test/invite#inv_ff',
    );
  });

  it('never puts the token anywhere but after the hash', () => {
    // The whole reason decision 6 uses a fragment: what is after `#` is not
    // sent with the request, so it cannot reach an access log or a `Referer`.
    const address = invitationAddress('https://fathom.example.test', 'inv_secret');
    expect(address.split('#')[0]).not.toContain('inv_secret');
    expect(address.indexOf('inv_secret')).toBe(address.indexOf('#') + 1);
  });

  it('falls back to a path when there is no origin to name', () => {
    expect(invitationAddress('', 'inv_a1b2')).toBe('/invite#inv_a1b2');
  });
});

describe('the handover block on the board', () => {
  const html = renderToStaticMarkup(
    createElement(InvitationHandover, { token: 'inv_a1b2c3', origin: 'https://fathom.example.test' }),
  );

  it('shows the whole address, with a way to copy it', () => {
    expect(html).toContain('https://fathom.example.test/invite#inv_a1b2c3');
    expect(html).toContain('data-testid="invitation-address"');
    expect(html).toMatch(/Copy the address/);
  });

  it('says why the token is after the hash', () => {
    expect(html).toMatch(/not sent with the request/);
    expect(html).toMatch(/log/);
  });
});
