/** Home's tabs (ADR-0060 decision 7). */
export type HomeTab = 'designs' | 'passwords' | 'organisation' | 'admin';

/** Pure: the tabs Home shows, each only to someone who may use it. Designs is
 * everyone's; Passwords is a member's own vault, for anyone in an organisation,
 * its admins included (the owner could not find it under Organisation alone,
 * 2026-10-26; the admin's view of everyone's stays there); Organisation is for the organisation's admins; Admin is for a
 * browser on the host the operator console answers on, until the server says
 * this account holds no operator custody. */
export function homeTabs({
  organisationAdmin,
  admin,
  waitingInvitee = false,
  member = false,
}: {
  organisationAdmin: boolean;
  admin: boolean;
  /** Joined from an invitation and not yet confirmed: no tabs to choose between. */
  waitingInvitee?: boolean;
  /** In a real organisation (not only the practice space). */
  member?: boolean;
}): HomeTab[] {
  const tabs: HomeTab[] = ['designs'];
  if (waitingInvitee) return tabs;
  if (member) tabs.push('passwords');
  if (organisationAdmin) tabs.push('organisation');
  if (admin) tabs.push('admin');
  return tabs;
}
