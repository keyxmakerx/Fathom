import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LiveNotices } from './LiveNotices';
import type { LiveStatus } from './useDesignSession';

const QUIET: LiveStatus = { mode: 'live', connected: true, reconnecting: false, pendingCount: 0, note: null, overwrite: null, people: [] };
const noop = () => {};

function render(live: LiveStatus): string {
  return renderToStaticMarkup(createElement(LiveNotices, { live, onKeepTheirs: noop, onPutMineBack: noop, onDismissNote: noop }));
}

describe('LiveNotices', () => {
  it('draws nothing while all is well', () => {
    expect(render(QUIET)).toBe('');
  });

  it('says it is reconnecting and that changes are kept', () => {
    expect(render({ ...QUIET, connected: false, reconnecting: true })).toContain('Reconnecting; your changes are kept.');
  });

  it('is silent about a connection in a design without a live feed', () => {
    expect(render({ ...QUIET, mode: 'legacy', connected: false, reconnecting: true })).toBe('');
  });

  it('offers Keep theirs and Put mine back beside the sentence', () => {
    const markup = render({ ...QUIET, overwrite: { sentence: 'SK changed hostname just after you.', overwrite: { element: 'e', key: 'Device.hostname', by: 'x', mine: { presence: 'set', value: 'a' }, at: 1 } } });
    expect(markup).toContain('SK changed hostname just after you.');
    expect(markup).toContain('>Keep theirs<');
    expect(markup).toContain('>Put mine back<');
  });

  it('shows a dropped change once, dismissable', () => {
    const markup = render({ ...QUIET, note: 'Your change "x" no longer fit what others did, so it was left out.' });
    expect(markup).toContain('no longer fit');
    expect(markup).toContain('aria-label="Dismiss"');
  });
});
