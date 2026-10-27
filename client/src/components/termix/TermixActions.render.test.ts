import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { TermixActions } from './TermixActions';

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
