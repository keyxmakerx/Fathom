import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ByHandSteps } from '../firmware/ByHand';
import { CommandToType } from './CommandToType';
import { commandParts, TypeItYourself } from './typeItYourself';

describe('commandParts', () => {
  it('labels each part of a Junos command', () => {
    expect(commandParts('request system software add /var/tmp/junos-21.4R3.tgz no-validate')).toEqual([
      { text: 'request', label: 'command' },
      { text: 'system', label: 'word' },
      { text: 'software', label: 'word' },
      { text: 'add', label: 'word' },
      { text: '/var/tmp/junos-21.4R3.tgz', label: 'path' },
      { text: 'no-validate', label: 'word' },
    ]);
  });

  it('keeps a quoted string and a placeholder whole, and finds options, files, values and links', () => {
    expect(commandParts('scp -P 22 "my image.bin" admin@10.0.0.1:/var/tmp/ <one-time link> cat9k.17.09.04a.SPA.bin')).toEqual([
      { text: 'scp', label: 'command' },
      { text: '-P', label: 'option' },
      { text: '22', label: 'value' },
      { text: '"my image.bin"', label: 'text' },
      { text: 'admin@10.0.0.1:/var/tmp/', label: 'word' },
      { text: '<one-time link>', label: 'link' },
      { text: 'cat9k.17.09.04a.SPA.bin', label: 'file' },
    ]);
  });

  it('labels the real one-time link inside a command as the link', () => {
    const url = 'https://fathom.example/fw/fetch/abc';
    expect(commandParts(`copy ${url} flash:`, url).map((p) => p.label)).toEqual(['command', 'link', 'path']);
  });

  it('gives nothing for an empty command', () => {
    expect(commandParts('   ')).toEqual([]);
  });
});

describe('CommandToType', () => {
  it('masks the link and says the whole command for a screen reader', () => {
    const url = 'https://fathom.example/fw/fetch/secret';
    const html = renderToStaticMarkup(createElement(CommandToType, { command: `fetch ${url}`, link: url, shownLink: 'https://fathom.example/fw/fetch/••••' }));
    expect(html).not.toContain('secret');
    expect(html).toContain('aria-label="Type: fetch https://fathom.example/fw/fetch/••••"');
    expect(html).toContain('type-cmd__label');
  });
});

describe('the by-hand steps', () => {
  const way = {
    way: 'scp',
    label: 'Over SSH',
    warning: null,
    windows: [{ order: 1, at: 'computer' as const, step: 'copy the file', command: 'scp image.tgz admin@switch:/var/tmp/', note: '' }],
    linux: [],
  };
  const render = (on: boolean) =>
    renderToStaticMarkup(createElement(TypeItYourself.Provider, { value: on }, createElement(ByHandSteps, { way: way as never, os: 'windows' })));

  it('offers copy buttons when it is off', () => {
    const html = render(false);
    expect(html).toContain('>Copy<');
    expect(html).toContain('Copy all');
    expect(html).not.toContain('type-cmd');
  });

  it('shows the command in labelled parts with no copy button when it is on', () => {
    const html = render(true);
    expect(html).not.toContain('>Copy<');
    expect(html).not.toContain('Copy all');
    expect(html).toContain('type-cmd');
    expect(html).toContain('Commands are shown to be typed');
  });
});
