import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { TermixActions } from './TermixActions';
import { TermixSend } from './TermixSend';

const render = (origin: string | null, address: string) => renderToStaticMarkup(createElement(TermixActions, { name: 'core-sw1', address, origin }));

describe('TermixActions (render-to-string)', () => {
  it('offers Open in Termix when the server names a Termix and the device has an address', () => {
    expect(render('https://termix.example.lan', '10.0.0.1')).toContain('Open in Termix');
  });

  it('shows nothing without a Termix or without an address', () => {
    expect(render(null, '10.0.0.1')).toBe('');
    expect(render('https://termix.example.lan', '  ')).toBe('');
  });
});

describe('TermixSend (render-to-string)', () => {
  const send = (origin: string | null, addresses: string[]) =>
    renderToStaticMarkup(createElement(TermixSend, { design: 'HQ', origin, devices: addresses.map((address, i) => ({ name: `d${i}`, address })) }));

  it('counts only the ticked devices that have an address', () => {
    expect(send('https://termix.example.lan', ['10.0.0.1', '', '10.0.0.3'])).toContain('Send 2 to Termix');
  });

  it('shows nothing without a Termix', () => {
    expect(send(null, ['10.0.0.1'])).toBe('');
  });
});
