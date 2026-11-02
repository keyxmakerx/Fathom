/**
 * The Steward list, as data (ADR-0088, sign-off r88-ui-map, pick "rail" A).
 *
 * Every page a Steward reaches sits in one of four quiet groups, in a fixed
 * order. Build threads add their page by flipping its `built` to true and
 * giving `OrganisationTab` a body for it; nobody reorders another thread's
 * entry. An entry that is not built is not shown, and a group with nothing
 * shown has no heading.
 */

/** Every Steward page, built or reserved. */
export type StewardPage =
  | 'people'
  | 'teams'
  | 'waiting'
  | 'folders'
  | 'firmware'
  | 'device-reading'
  | 'order-types'
  | 'mail'
  | 'passwords'
  | 'ai'
  | 'ai-rules';

export interface StewardEntry {
  page: StewardPage;
  label: string;
  /** False until the thread that owns it lands its screen. */
  built: boolean;
  /** Who builds it, so a thread knows whose line it is (ADR-0088's table). */
  owner: string;
}

export interface StewardGroup {
  heading: string;
  entries: readonly StewardEntry[];
}

export const STEWARD_RAIL: readonly StewardGroup[] = [
  {
    heading: 'People',
    entries: [
      { page: 'people', label: 'People', built: true, owner: 'built' },
      { page: 'teams', label: 'Teams', built: false, owner: 'ADR-0081 teams' },
      { page: 'waiting', label: 'Waiting for you', built: true, owner: 'built' },
    ],
  },
  {
    heading: 'Estate',
    entries: [
      { page: 'folders', label: 'Folders', built: true, owner: 'built' },
      { page: 'firmware', label: 'Firmware', built: true, owner: 'built' },
      { page: 'device-reading', label: 'Device reading', built: false, owner: 'ADR-0082 device reading' },
    ],
  },
  {
    heading: 'Work',
    entries: [
      { page: 'order-types', label: 'Order types', built: false, owner: 'ADR-0084 orders' },
      { page: 'mail', label: 'Mail', built: false, owner: 'ADR-0085 email' },
    ],
  },
  {
    heading: 'Passwords and AI',
    entries: [
      { page: 'passwords', label: 'Passwords', built: true, owner: 'built' },
      { page: 'ai', label: 'AI', built: true, owner: 'built' },
      { page: 'ai-rules', label: 'AI rules', built: true, owner: 'built' },
    ],
  },
];

/** Pure: the groups to draw, each with only its built entries; `waiting` only once its count has loaded. */
export function shownRail({ waitingReady }: { waitingReady: boolean }, rail: readonly StewardGroup[] = STEWARD_RAIL): StewardGroup[] {
  return rail
    .map((group) => ({
      heading: group.heading,
      entries: group.entries.filter((entry) => entry.built && (entry.page !== 'waiting' || waitingReady)),
    }))
    .filter((group) => group.entries.length > 0);
}
