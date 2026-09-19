import { describe, expect, it } from 'vitest';

import { canStewardFor } from './capabilities';

describe('canStewardFor', () => {
  it('allows creating a scope for "steward"', () => {
    expect(canStewardFor('steward')).toBe(true);
  });

  it('refuses for "draw"', () => {
    expect(canStewardFor('draw')).toBe(false);
  });

  it('refuses for "read"', () => {
    expect(canStewardFor('read')).toBe(false);
  });

  it('fails CLOSED for a capability this client does not recognise — the opposite of canDrawFor', () => {
    expect(canStewardFor('some-future-capability')).toBe(false);
  });
});
