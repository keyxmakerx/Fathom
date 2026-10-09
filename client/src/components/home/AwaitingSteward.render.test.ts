import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AwaitingStewardView } from './AwaitingSteward';

describe('waiting for a steward to confirm you', () => {
  it('says plainly that a steward has to confirm, and shows the code to read out', () => {
    const html = renderToStaticMarkup(createElement(AwaitingStewardView, { code: 'QDMPW1FAVF' }));
    expect(html).toContain('Waiting for a steward to confirm you');
    expect(html).toContain('QDMPW 1FAVF');
    expect(html).toContain('before you can see anything here');
    expect(html).toContain('someone else may have used your link');
  });

  it('shows no code rather than a made-up one', () => {
    expect(renderToStaticMarkup(createElement(AwaitingStewardView, { code: null }))).not.toContain('home__key-code');
  });
});
