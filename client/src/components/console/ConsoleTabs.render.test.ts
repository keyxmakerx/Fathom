import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ConsoleTabs, consoleSections } from './ConsoleTabs';

// The console's section row (owner, 2026-10-12: Admin was one long page and
// "i got lost"). Render-to-string, per `SignIn.render.test.ts`.

describe('the console section tabs', () => {
  it('offers Accounts first, and Issued only once something was minted', () => {
    expect(consoleSections(false)).toEqual(['accounts', 'organisations', 'operators', 'ai', 'settings']);
    expect(consoleSections(true)).toEqual(['accounts', 'organisations', 'operators', 'ai', 'settings', 'issued']);
  });

  it('marks exactly the current section', () => {
    const html = renderToStaticMarkup(
      createElement(ConsoleTabs, { sections: consoleSections(true), current: 'accounts', onSelect: () => {} }),
    );
    expect(html).toContain('Accounts');
    expect(html).toContain('Issued');
    expect((html.match(/aria-selected="true"/g) ?? []).length).toBe(1);
    expect(html).toMatch(/console__tab console__tab--on"[^>]*data-testid="console-tab-accounts"/);
  });
});
