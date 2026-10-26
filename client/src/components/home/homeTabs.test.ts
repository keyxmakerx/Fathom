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

  it('gives every member their own Passwords, admins included', () => {
    expect(homeTabs({ organisationAdmin: false, admin: false, member: true })).toEqual(['designs', 'passwords']);
    expect(homeTabs({ organisationAdmin: false, admin: true, member: true })).toEqual(['designs', 'passwords', 'admin']);
    expect(homeTabs({ organisationAdmin: true, admin: false, member: true })).toEqual(['designs', 'passwords', 'organisation']);
    expect(homeTabs({ organisationAdmin: true, admin: true, member: true })).toEqual(['designs', 'passwords', 'organisation', 'admin']);
  });

  it('gives someone who joined from an invitation and still waits no tabs to choose between', () => {
    expect(homeTabs({ organisationAdmin: true, admin: true, waitingInvitee: true, member: true })).toEqual(['designs']);
    expect(homeTabs({ organisationAdmin: false, admin: true, waitingInvitee: false })).toEqual(['designs', 'admin']);
  });
});
