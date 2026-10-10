import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Account } from './Account';
import { Appearance } from './Appearance';

describe('Appearance', () => {
  it('offers System, Light and Dark, with System chosen when nothing is stored', () => {
    const html = renderToStaticMarkup(createElement(Appearance));
    expect(html).toContain('Appearance');
    for (const word of ['System', 'Light', 'Dark']) expect(html).toContain(`<span>${word}</span>`);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toContain('appearance__segment--on"><input type="radio" name="account-theme" checked="" value="system"');
  });

  it('is on the account screen the person opened, not the forced app-code one', () => {
    const settings = renderToStaticMarkup(createElement(Account, { address: 'a@example.test' }));
    expect(settings).toContain('id="account-appearance"');
    const forced = renderToStaticMarkup(createElement(Account, { address: 'a@example.test', purpose: 'app-code' }));
    expect(forced).not.toContain('id="account-appearance"');
  });
});
