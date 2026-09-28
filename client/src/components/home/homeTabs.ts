/** Home's tabs (ADR-0060 decision 7). */
export type HomeTab = 'designs' | 'organisation' | 'admin';

/** Pure: the tabs Home shows, each only to someone who may use it. Designs is
 * everyone's; Organisation is for the organisation's admins; Admin is for a
 * browser on the host the operator console answers on, until the server says
 * this account holds no operator custody. */
export function homeTabs({ organisationAdmin, admin }: { organisationAdmin: boolean; admin: boolean }): HomeTab[] {
  const tabs: HomeTab[] = ['designs'];
  if (organisationAdmin) tabs.push('organisation');
  if (admin) tabs.push('admin');
  return tabs;
}
