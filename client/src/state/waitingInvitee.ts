// Whether this browser joined from an invitation and the person is still waiting
// for a steward to confirm them. The server holds no such fact for the account
// to read, so this is a local note made at the moment of joining, and dropped as
// soon as the account belongs to an organisation. It only decides what Home
// leaves out (Admin, Claim an organisation, the Designs tab); it grants nothing,
// and losing it only brings those back.

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const key = (address: string) => `fathom.joined-from-invitation:${address}`;

const defaultStore = (): Store | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

export function markJoinedFromInvitation(address: string, store: Store | undefined = defaultStore()): void {
  try {
    store?.setItem(key(address), '1');
  } catch {
    // Private browsing and the like: the note is a convenience, not a fact.
  }
}

export function wasJoinedFromInvitation(address: string, store: Store | undefined = defaultStore()): boolean {
  try {
    return store?.getItem(key(address)) === '1';
  } catch {
    return false;
  }
}

export function clearJoinedFromInvitation(address: string, store: Store | undefined = defaultStore()): void {
  try {
    store?.removeItem(key(address));
  } catch {
    // as above
  }
}

/**
 * Still waiting: the organisations have loaded, there are none, and this browser
 * joined from an invitation. Someone with no organisation who did not join that
 * way is a claimant, and keeps Claim an organisation.
 */
export function stillWaitingInvitee(organisationCount: number | null, joinedFromInvitation: boolean): boolean {
  return organisationCount === 0 && joinedFromInvitation;
}
