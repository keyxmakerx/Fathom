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

describe('PracticeWelcome with "Start your own network" (sign-off r123)', () => {
  const own = { onMake: async () => false, busy: false, error: null, codePrompt: null };

  it('offers its own network beside the practice lab, which keeps its place and words', () => {
    const html = renderToStaticMarkup(createElement(PracticeWelcome, { address: 'sam@example.com', offer, onOpen: () => {}, own }));
    expect(html.indexOf('Open the practice home lab')).toBeLessThan(html.indexOf('Start your own network'));
    expect(html).toContain('Open practice lab');
    expect(html).toContain('value="Home network"');
    expect(html).toContain('Start drawing');
    expect(html).toContain('Running this for a team?');
    expect(html).not.toContain('When people are ready to draw for real');
  });

  it('shows no recovery key until Start drawing is pressed, so nothing is made on sight', () => {
    const html = renderToStaticMarkup(createElement(PracticeWelcome, { address: 'a@b', offer, onOpen: () => {}, own }));
    expect(html).not.toContain('recovery key');
  });

  it('leaves the card out where it is not offered', () => {
    const html = renderToStaticMarkup(createElement(PracticeWelcome, { address: 'a@b', offer, onOpen: () => {} }));
    expect(html).not.toContain('Start your own network');
    expect(html).toContain('When people are ready to draw for real');
  });
});
