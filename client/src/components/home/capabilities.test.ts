import { describe, expect, it } from 'vitest';

import { canStageFirmwareFor, canStewardFor } from './capabilities';

describe('canStewardFor', () => {
  it('allows creating a scope for "steward"', () => {
    expect(canStewardFor('steward')).toBe(true);
  });

  it('refuses for "firmware": Firmware is below Steward (r95)', () => {
    expect(canStewardFor('firmware')).toBe(false);
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

describe('canStageFirmwareFor (r95)', () => {
  it('allows Firmware and Steward', () => {
    expect(canStageFirmwareFor('firmware')).toBe(true);
    expect(canStageFirmwareFor('steward')).toBe(true);
  });

  it('refuses Draw, Read and anything it does not recognise', () => {
    for (const c of ['draw', 'read', 'some-future-capability']) expect(canStageFirmwareFor(c)).toBe(false);
  });
});
