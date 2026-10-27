import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { parseActivity } from '../../api/activity';
import { concatBytes, lp, utf8 } from '../../crypto/bytes';
import { ActivityView, entryWords, matchesFilter } from './ActivityPanel';

// Admin › Activity. The bytes are the shape `admin.rs`'s `activity` answers.

const line = (...f: string[]) => lp(utf8(f.join('\t')));

describe('the activity page', () => {
  const bytes = concatBytes(
    line('12', '1793131179', 'account_created', '1', 'A1', 'Ada', '203.0.113.9', '10.0.0.2', ''),
    line('11', '1793131100', 'operator_signin_failed', '1', '', '', '198.51.100.4', '10.0.0.2', 'password_refused'),
    line('10', '1793131000', 'operator_signin', '0', '', '', '', '', ''),
    line('9', '1793130000', 'operator_signin', '1', 'A1', 'Ada', '', '', ''),
  );

  it('reads every line', () => {
    const e = parseActivity(bytes);
    expect(e.map((x) => x.seq)).toEqual([12, 11, 10, 9]);
    expect(e[0].client).toBe('203.0.113.9');
    expect(e[2].verified).toBe(false);
  });

  it('refuses a line of the wrong shape', () => {
    expect(() => parseActivity(lp(utf8('1\t2\t3')))).toThrow(/malformed/);
  });

  it('shows the address, the proxy, a refusal reason, an unverified entry and an old one without an address', () => {
    const html = renderToStaticMarkup(
      createElement(ActivityView, { loaded: { status: 'ready', value: parseActivity(bytes) }, filter: 'all' }),
    );
    expect(html).toContain('203.0.113.9');
    expect(html).toContain('10.0.0.2');
    expect(html).toContain('Admin sign-in refused');
    expect(html).toContain('password refused');
    expect(html).toContain('did not verify');
    expect(html).toContain('not recorded');
  });

  it('filters sign-ins and refusals', () => {
    const e = parseActivity(bytes);
    expect(e.filter((x) => matchesFilter(x, 'refused')).map((x) => x.seq)).toEqual([11]);
    expect(e.filter((x) => matchesFilter(x, 'signins')).map((x) => x.seq)).toEqual([11, 10, 9]);
    expect(entryWords('something_new')).toBe('something new');
  });
});
