import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LiveNotices } from './LiveNotices';
import type { LiveStatus } from './useDesignSession';

const QUIET: LiveStatus = { mode: 'live', connected: true, reconnecting: false, pendingCount: 0, note: null, overwrite: null, merged: null, self: null, people: [] };
const noop = () => {};
const REGION = '<div class="live-notices" role="status" aria-live="polite">';

function render(live: LiveStatus): string {
  return renderToStaticMarkup(createElement(LiveNotices, { live, onKeepTheirs: noop, onPutMineBack: noop, onDismissNote: noop }));
}

describe('LiveNotices', () => {
  it('always draws the polite status region, empty while all is well', () => {
    expect(render(QUIET)).toBe(`${REGION}</div>`);
  });

  it('keeps the region (empty) in a design without a live feed', () => {
    expect(render({ ...QUIET, mode: 'legacy', connected: false, reconnecting: true })).toBe(`${REGION}</div>`);
  });

  it('says it is reconnecting and that changes are kept', () => {
    const markup = render({ ...QUIET, connected: false, reconnecting: true });
    expect(markup.startsWith(REGION)).toBe(true);
    expect(markup).toContain('Reconnecting; your changes are kept.');
  });

  it('names the person, field and device, shows yours→theirs, and offers the two buttons', () => {
    const markup = render({
      ...QUIET,
      overwrite: {
        lines: ['Bob changed the serial on core-sw-01 just after you'],
        items: [{ id: 'e\nk', yours: 'yours SN-ANN-1 → Bob’s SN-BOB-2' }],
        keep: 'Keep Bob’s',
      },
    });
    expect(markup).toContain('<b>Bob changed the serial on core-sw-01</b> just after you');
    expect(markup).toContain('yours SN-ANN-1 → Bob’s SN-BOB-2');
    expect(markup).toContain('>Keep Bob’s<');
    expect(markup).toContain('>Put mine back<');
    expect(markup).toContain('live-notice--ink');
  });

  it('merges several overwrites into one notice, each with its own line and Put mine back', () => {
    const markup = render({
      ...QUIET,
      overwrite: {
        lines: ['Bob changed the serial on a just after you', 'Bob changed the name on b just after you'],
        items: [
          { id: '1', yours: 'yours 1 → Bob’s 2' },
          { id: '2', yours: 'yours x → Bob’s y' },
        ],
        keep: 'Keep Bob’s',
      },
    });
    expect(markup.match(/data-testid="live-overwrite"/g)).toHaveLength(1);
    expect(markup.match(/>Put mine back</g)).toHaveLength(2);
    expect(markup.match(/>Keep Bob’s</g)).toHaveLength(1);
    expect(markup).toContain('yours 1 → Bob’s 2');
    expect(markup).toContain('yours x → Bob’s y');
  });

  it('says once that a change merged, as a muted line', () => {
    const markup = render({ ...QUIET, merged: 'Your serial change merged with Bob’s. Both are in history.' });
    expect(markup).toContain('live-notice__muted');
    expect(markup).toContain('Your serial change merged with Bob’s. Both are in history.');
  });

  it('shows a dropped change once, dismissable', () => {
    const markup = render({ ...QUIET, note: 'Your change "x" no longer fit what others did, so it was left out.' });
    expect(markup).toContain('no longer fit');
    expect(markup).toContain('aria-label="Dismiss"');
  });

  it('sizes the buttons to at least 24px and the dismiss to 24 by 24', () => {
    const css = readFileSync('src/components/design/liveNotices.css', 'utf8');
    expect(css).toMatch(/\.live-notice__btn\s*\{[^}]*min-height:\s*24px/);
    expect(css).toMatch(/\.live-notice__close\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px/);
  });
});
