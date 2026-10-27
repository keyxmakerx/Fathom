// ADR-0074 §1 and §2: what kind of place a folder is, and its hand-set role. The words are
// the server's (`ScopeKind::place_forms`, `PLACE_ROLES`, migration 0050); the labels are what
// a person reads. A site or a building takes the schema's `Premises.form` words for a place
// you walk into; a closet folder takes a kind of room. Only a site or a building has a role.

export interface PlaceOption {
  value: string;
  label: string;
}

const BUILDING_FORMS: PlaceOption[] = [
  { value: 'central_office', label: 'Central office' },
  { value: 'data_centre', label: 'Datacenter' },
  { value: 'hut', label: 'Hut' },
  { value: 'cabinet', label: 'Street cabinet' },
  { value: 'headend', label: 'Headend' },
  { value: 'customer_premises', label: 'Customer premises' },
  { value: 'other', label: 'Other' },
];

const ROOM_FORMS: PlaceOption[] = [
  { value: 'closet', label: 'Closet' },
  { value: 'data_hall', label: 'Data hall' },
  { value: 'ups_room', label: 'UPS room' },
  { value: 'meet_me_room', label: 'Meet-me room' },
  { value: 'other', label: 'Other' },
];

export const PLACE_ROLES: PlaceOption[] = [
  { value: 'hub', label: 'Hub' },
  { value: 'branch', label: 'Branch' },
  { value: 'customer', label: 'Customer' },
  { value: 'other', label: 'Other' },
];

/** The place kinds a folder of the server's `kind` may take. */
export function placeFormsFor(kind: string): PlaceOption[] {
  return kind === 'rack' ? ROOM_FORMS : BUILDING_FORMS;
}

/** Whether a folder of the server's `kind` may carry a role. A closet is never a hub. */
export function takesRole(kind: string): boolean {
  return kind !== 'rack';
}

/** The server's kind for the level a "New site/building/closet" button names. */
export function kindForLevel(level: string): string {
  return level === 'site' ? 'network' : level === 'closet' ? 'rack' : 'building';
}

export function placeFormLabel(kind: string, form: string | null | undefined): string | null {
  if (!form) return null;
  return placeFormsFor(kind).find((o) => o.value === form)?.label ?? form;
}

export function placeRoleLabel(role: string | null | undefined): string | null {
  if (!role) return null;
  return PLACE_ROLES.find((o) => o.value === role)?.label ?? role;
}
