import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LiveNotices, announcement, hasLiveNotices } from './LiveNotices';
import type { LiveStatus } from './useDesignSession';

const QUIET: LiveStatus = { mode: 'live', connected: true, reconnecting: false, pendingCount: 0, note: null, overwrite: null, merged: null, self: null, people: [] };
const noop = () => {};
function render(live: LiveStatus): string {
  return renderToStaticMarkup(createElement(LiveNotices, { live, onKeepTheirs: noop, onPutMineBack: noop, onDismissNote: noop }));
}

const one = (extra = {}) => ({
  lines: ['Bob Roe changed the serial on core-sw-01 just after you'],
  parts: [{ head: 'Bob Roe changed the serial', on: 'core-sw-01', tail: ' just after you' }],
  items: [{ id: 'e\nk', yours: 'yours SN-ANN-1 → Bob’s SN-BOB-2', field: 'serial' }],
  keep: 'Keep Bob’s',
  anchor: 'serial',
  element: 'e',
  ...extra,
});

describe('LiveNotices', () => {
  it('draws nothing while all is well, and is not itself a live region', () => {
    expect(hasLiveNotices(QUIET)).toBe(false);
    expect(render(QUIET)).toBe('');
    expect(render({ ...QUIET, connected: false, reconnecting: true })).not.toContain('role=');
  });

  it('draws nothing about a connection in a design without a live feed', () => {
    expect(hasLiveNotices({ ...QUIET, mode: 'legacy', reconnecting: true })).toBe(false);
    expect(render({ ...QUIET, mode: 'legacy', connected: false, reconnecting: true })).toBe('');
  });

  it('says it is reconnecting and that changes are kept', () => {
    const markup = render({ ...QUIET, connected: false, reconnecting: true });
    expect(markup).toContain('Reconnecting; your changes are kept.');
  });

  it('once reconnecting has gone on, says what it keeps running into', () => {
    const stuck = 'The server answered 429: too many live streams for this account';
    const markup = render({ ...QUIET, connected: false, reconnecting: true, stuck });
    expect(markup).toContain(`Still trying. ${stuck}`);
    expect(announcement({ ...QUIET, reconnecting: true, stuck })).toBe(`Reconnecting; your changes are kept. Still trying. ${stuck}`);
  });

  it('names the person, field and device, shows yours→theirs, and offers the two buttons', () => {
    const markup = render({ ...QUIET, overwrite: one() });
    expect(markup).toContain('<b>Bob Roe changed the serial on <span class="live-notice__device">core-sw-01</span></b> just after you');
    expect(markup).toContain('yours SN-ANN-1 → Bob’s SN-BOB-2');
    expect(markup).not.toContain('Serial: yours');
    expect(markup).toContain('>Keep Bob’s<');
    expect(markup).toContain('>Put mine back<');
    expect(markup).toContain('live-notice--ink');
    expect(markup).not.toContain('role=');
  });

  it('merges several overwrites into one notice, each line labelled, each button named for its field', () => {
    const markup = render({
      ...QUIET,
      overwrite: one({
        items: [
          { id: '1', yours: 'yours 10.0.0.1 → Bob’s 10.0.0.2', field: 'mgmt address' },
          { id: '2', yours: 'yours x → Bob’s y', field: 'serial' },
        ],
      }),
    });
    expect(markup.match(/data-testid="live-overwrite"/g)).toHaveLength(1);
    expect(markup.match(/>Put mine back</g)).toHaveLength(2);
    expect(markup).toContain('aria-label="Put my mgmt address back"');
    expect(markup).toContain('aria-label="Put my serial back"');
    expect(markup).toContain('Mgmt address: yours 10.0.0.1 → Bob’s 10.0.0.2');
    expect(markup).toContain('Serial: yours x → Bob’s y');
    expect(markup.match(/>Keep Bob’s</g)).toHaveLength(1);
  });

  it('says once that a change merged, as a muted line', () => {
    const markup = render({ ...QUIET, merged: 'Your model change merged; you changed different fields. Both are in history.' });
    expect(markup).toContain('live-notice__muted');
    expect(markup).toContain('Your model change merged; you changed different fields. Both are in history.');
  });

  it('shows a dropped change once, dismissable', () => {
    const markup = render({ ...QUIET, note: 'Your change "x" no longer fit what others did, so it was left out.' });
    expect(markup).toContain('no longer fit');
    expect(markup).toContain('aria-label="Dismiss"');
  });

  it('gives the hidden status region the words, in one string', () => {
    expect(announcement(QUIET)).toBe('');
    expect(announcement({ ...QUIET, overwrite: one(), merged: 'Merged.' })).toBe('Bob Roe changed the serial on core-sw-01 just after you. Merged.');
    expect(announcement({ ...QUIET, reconnecting: true })).toBe('Reconnecting; your changes are kept.');
  });

  it('keeps a device name on one line and sizes the buttons to at least 24px and the dismiss to 24 by 24', () => {
    const css = readFileSync('src/components/design/liveNotices.css', 'utf8');
    expect(css).toMatch(/\.live-notice__device\s*\{[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/\.live-notice__btn\s*\{[^}]*min-height:\s*24px/);
    expect(css).toMatch(/\.live-notice__close\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px/);
  });
});
