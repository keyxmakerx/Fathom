import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { HomeTabs } from './HomeTabs';

describe('Home\'s tab row (r116)', () => {
  const html = renderToStaticMarkup(createElement(HomeTabs, { tabs: ['designs', 'work', 'passwords', 'organisation', 'admin'], current: 'designs', onSelect: () => {} }));

  it('has Admin last, set apart from the organisation\'s tabs', () => {
    expect(html.lastIndexOf('>Admin<')).toBeGreaterThan(html.lastIndexOf('>Steward<'));
    expect(html).toMatch(/class="home-tabs__tab home-tabs__tab--apart"[^>]*>Admin</);
  });

  it('sets only Admin apart', () => {
    expect((html.match(/home-tabs__tab--apart/g) ?? []).length).toBe(1);
  });
});
