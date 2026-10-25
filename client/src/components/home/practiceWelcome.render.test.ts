import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PracticeWelcome } from './PracticeWelcome';

const offer = { onMake: async () => null, busy: false, error: null, codePrompt: null, justMade: null, onOpened: () => {} };

describe('PracticeWelcome (ADR-0069)', () => {
  it('offers the practice lab and never asks for an organisation', () => {
    const html = renderToStaticMarkup(createElement(PracticeWelcome, { address: 'sam@example.com', offer, onOpen: () => {} }));
    expect(html).toContain('You set this server up.');
    expect(html).toContain('Open practice lab');
    expect(html).toContain('only you can see it');
    expect(html).toContain('Nothing here asks you to do it.');
    expect(html).not.toContain('Waiting for a steward');
  });

  it('says so while the space is being made, and shows a refusal', () => {
    const html = renderToStaticMarkup(
      createElement(PracticeWelcome, { address: 'a@b', offer: { ...offer, busy: true, error: 'Refused.' }, onOpen: () => {} }),
    );
    expect(html).toContain('Making your practice space…');
    expect(html).toContain('Refused.');
  });
});
