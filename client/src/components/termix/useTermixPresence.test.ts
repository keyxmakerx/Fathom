import { expect, it } from 'vitest';

import { IN_TERMIX, NOT_IN_TERMIX, presenceCell } from './useTermixPresence';

const hosts = [{ id: 1, name: 'router-1', ip: '192.0.2.1', port: 22 }];

it('says In Termix, Not in Termix, or nothing when it cannot know', () => {
  expect(presenceCell(hosts, '192.0.2.1/24')).toBe(IN_TERMIX);
  expect(presenceCell(hosts, '192.0.2.9')).toBe(NOT_IN_TERMIX);
  expect(presenceCell(hosts, '')).toBe('');
  expect(presenceCell(null, '192.0.2.1')).toBe('');
});
