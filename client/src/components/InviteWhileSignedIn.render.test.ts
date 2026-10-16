import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { InviteWhileSignedIn } from './InviteWhileSignedIn';

// Render-to-string, per `Enrol.render.test.ts`. An invitation link opened by
// someone already signed in used to land on Home with no explanation (owner,
// 2026-10-12).

const markup = () =>
  renderToStaticMarkup(
    createElement(InviteWhileSignedIn, {
      address: 'owner@example.test',
      onBack: () => {},
      onSignOutAndUse: () => {},
    }),
  );

describe('an invitation link opened while signed in', () => {
  it('says what the link is and who this browser is signed in as', () => {
    const html = markup();
    expect(html).toContain('This is an invitation link');
    expect(html).toContain('owner@example.test');
    expect(html).toMatch(/send it to them/i);
  });

  it('offers exactly the two ways on', () => {
    const html = markup();
    expect(html).toContain('Back to Fathom');
    expect(html).toContain('Sign out and use it');
    expect((html.match(/<button/g) ?? []).length).toBe(2);
  });

  it('never prints a token', () => {
    expect(markup()).not.toContain('inv_');
  });
});
