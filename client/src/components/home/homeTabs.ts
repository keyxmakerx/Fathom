/** Home's tabs (ADR-0060 decision 7). */
export type HomeTab = 'designs' | 'work' | 'passwords' | 'organisation' | 'ai' | 'admin';

/** Pure: the tabs Home shows, each only to someone who may use it. Designs is
 * everyone's; Passwords is a member's own vault, for anyone in an organisation,
 * its admins included (the owner could not find it under Organisation alone,
 * 2026-10-26; the admin's view of everyone's stays there); Steward (the
 * `organisation` tab) is for the organisation's admins and folder stewards; AI
 * is for someone a Steward named to connect AI apps who stewards nothing; Admin
 * is the server's console, for a browser on the host it answers on, until the
 * server says this account holds no operator custody. Steward and Admin are
 * separate tabs because they are separate roles: an organiser outside the
 * console's allow list still has Steward (owner, 2026-10-27). */
export function homeTabs({
  organisationAdmin,
  aiMaker = false,
  admin,
  waitingInvitee = false,
  member = false,
  work = false,
}: {
  organisationAdmin: boolean;
  /** Named to connect AI apps here, and no admin or steward (ADR-0072). */
  aiMaker?: boolean;
  admin: boolean;
  /** Joined from an invitation and not yet confirmed: no tabs to choose between. */
  waitingInvitee?: boolean;
  /** In a real organisation (not only the practice space). */
  member?: boolean;
  /** In any organisation, the practice space included: the Work tab lists its work (sign-off r74). */
  work?: boolean;
}): HomeTab[] {
  const tabs: HomeTab[] = ['designs'];
  if (waitingInvitee) return tabs;
  if (work) tabs.push('work');
  if (member) tabs.push('passwords');
  if (organisationAdmin) tabs.push('organisation');
  else if (aiMaker) tabs.push('ai');
  if (admin) tabs.push('admin');
  return tabs;
}
