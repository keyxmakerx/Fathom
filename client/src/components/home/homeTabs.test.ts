import { describe, expect, it } from 'vitest';

import { homeTabs } from './homeTabs';

describe('homeTabs', () => {
  it('gives everyone Designs', () => {
    expect(homeTabs({ organisationAdmin: false, admin: false })).toEqual(['designs']);
  });

  it("adds Organisation for the organisation's admins", () => {
    expect(homeTabs({ organisationAdmin: true, admin: false })).toEqual(['designs', 'organisation']);
  });

  it('adds Admin where the operator console answers, and keeps the order', () => {
    expect(homeTabs({ organisationAdmin: false, admin: true })).toEqual(['designs', 'admin']);
    expect(homeTabs({ organisationAdmin: true, admin: true })).toEqual(['designs', 'organisation', 'admin']);
  });
});
