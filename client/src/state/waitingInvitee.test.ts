import { describe, expect, it } from 'vitest';

import { clearJoinedFromInvitation, markJoinedFromInvitation, stillWaitingInvitee, wasJoinedFromInvitation } from './waitingInvitee';

const memory = () => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
};

describe('the note that this browser joined from an invitation', () => {
  it('is kept per address, and dropped when cleared', () => {
    const store = memory();
    expect(wasJoinedFromInvitation('ana-1', store)).toBe(false);
    markJoinedFromInvitation('ana-1', store);
    expect(wasJoinedFromInvitation('ana-1', store)).toBe(true);
    expect(wasJoinedFromInvitation('someone-else', store)).toBe(false);
    clearJoinedFromInvitation('ana-1', store);
    expect(wasJoinedFromInvitation('ana-1', store)).toBe(false);
  });

  it('does nothing, and does not throw, with no storage or a storage that refuses', () => {
    expect(() => markJoinedFromInvitation('a', undefined)).not.toThrow();
    expect(wasJoinedFromInvitation('a', undefined)).toBe(false);
    const refusing = {
      getItem: () => {
        throw new Error('no');
      },
      setItem: () => {
        throw new Error('no');
      },
      removeItem: () => {
        throw new Error('no');
      },
    };
    expect(() => markJoinedFromInvitation('a', refusing)).not.toThrow();
    expect(wasJoinedFromInvitation('a', refusing)).toBe(false);
    expect(() => clearJoinedFromInvitation('a', refusing)).not.toThrow();
  });
});

describe('who is still waiting', () => {
  it('is someone with no organisation who joined from an invitation, and only them', () => {
    expect(stillWaitingInvitee(0, true)).toBe(true);
    // A claimant joined by no invitation and keeps "Claim an organisation".
    expect(stillWaitingInvitee(0, false)).toBe(false);
    // Confirmed: an organisation has appeared.
    expect(stillWaitingInvitee(1, true)).toBe(false);
    // Not loaded yet: nothing is hidden on a guess.
    expect(stillWaitingInvitee(null, true)).toBe(false);
  });
});
