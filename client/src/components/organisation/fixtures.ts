// Shared fixtures for the People and Waiting render tests.

import type { Invitation } from '../../api/invitations';
import type { AccessRow, Person } from '../../api/people';
import type { Scope } from '../../api/scopes';

export const invitation = (n: number, over: Partial<Invitation> = {}): Invitation => ({
  id: `01JQZ00000000000000000A${String(n).padStart(3, '0')}`,
  account: `ACC${n}`,
  state: 'joined',
  displayName: ['Jo Kim', 'Ana Silva', 'Sam Okafor', 'Ravi Patel', 'Mei Chen'][n % 5],
  contactEmail: `p${n}@example.test`,
  signInName: `person-${n}-abcd1234`,
  capabilityAsked: 'draw',
  scopeId: 'S-LON1',
  scopeLabel: 'LON1',
  keyCode: 'QDMPW1FAVF',
  issuedBy: 'KM',
  issuedByName: 'Key Maker',
  issuedAtUnix: 1_800_000_000,
  joinedAtUnix: 1_800_003_600,
  windowEndsAtUnix: 1_801_209_600,
  expired: false,
  unverifiable: false,
  canConfirm: true,
  ...over,
});

export const folder = (id: string, name: string): Scope => ({
  scopeId: id,
  parentScopeId: null,
  kind: 'network',
  displayName: name,
  depth: 1,
  path: name,
  capability: 'steward',
});

export const access = (over: Partial<AccessRow> = {}): AccessRow => ({
  scopeId: 'S-LON1',
  label: 'LON1',
  capability: 'draw',
  grant: 'G1',
  inherited: false,
  genesis: false,
  revocable: true,
  effectiveFromUnix: 1_800_000_000,
  expiresAtUnix: null,
  revokeTakesEffectInSeconds: 0,
  revokingAtUnix: null,
  awaitingSecond: false,
  suspended: false,
  ...over,
});

export const person = (over: Partial<Person> = {}): Person => ({
  account: 'P1',
  name: 'Priya Rao',
  email: 'priya@example.test',
  you: false,
  state: 'active',
  invitation: null,
  asked: null,
  expired: false,
  access: [access(), access({ grant: 'G2', scopeId: null, label: 'Northwind', capability: 'read', revocable: false })],
  ...over,
});
