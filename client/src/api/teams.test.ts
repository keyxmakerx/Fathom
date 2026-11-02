import { describe, expect, it } from 'vitest';

import { toHex, utf8 } from '../crypto/bytes';
import { involvedIn, ledBy, parseHistory, parseTeams, powersText, slugOf, teamActBytes, teamRoleBytes, throughTeams, titleOf } from './teams';

// The literals below are `TEAM_MEMBER_ADD_BYTES` and `TEAM_GRANT_REVOKE_BYTES` in
// `crates/fathom-server/tests/authority_vectors.rs`, laid out there by an independent script.
// If this file and that one stop agreeing, the signed team act moved.

const MEMBER_ADD =
  '12000000666174686f6d2f7465616d2f6163742f76311a00000030314a515a3030303030303030303030303030303030303041412000000041414141414141414141414141414141414141414141414141414141414141411a00000030314a515a303030303030303030303030303030303030304a4a1a00000030314a515a3030303030303030303030303030303030303048480a0000006d656d6265725f6164641a00000030314a515a30303030303030303030303030303030303030434320000000424242424242424242424242424242424242424242424242424242424242424200000000000000000000000000000000000000001a00000030314a515a303030303030303030303030303030303030304444200000004343434343434343434343434343434343434343434343434343434343434343040000006c656164800e80690000000007000000';
const GRANT_REVOKE =
  '12000000666174686f6d2f7465616d2f6163742f76311a00000030314a515a3030303030303030303030303030303030303041412000000041414141414141414141414141414141414141414141414141414141414141411a00000030314a515a303030303030303030303030303030303030304a4a1a00000030314a515a3030303030303030303030303030303030303048480c0000006772616e745f7265766f6b6500000000200000000000000000000000000000000000000000000000000000000000000000000000000000001a00000030314a515a303030303030303030303030303030303030304242000000001a00000030314a515a303030303030303030303030303030303030304b4b200000000cb4b2e04bbe95f6867ecc52614f9e217c008e00dc0ad040154ec7e3427f343a1a00000030314a515a3030303030303030303030303030303030303044442000000043434343434343434343434343434343434343434343434343434343434343430700000073746577617264800e80690000000007000000';

const fill = (n: number) => new Uint8Array(32).fill(n);
const common = {
  organisation: '01JQZ0000000000000000000AA',
  rootPubkeyFpr: fill(0x41),
  actId: '01JQZ0000000000000000000JJ',
  team: '01JQZ0000000000000000000HH',
  role: null,
  capability: null,
  signer: '01JQZ0000000000000000000DD',
  signerKeyFpr: fill(0x43),
  atUnix: 1_770_000_000,
  authEpoch: 7,
};

describe('a team act’s signed bytes', () => {
  it('are the bytes the server builds for a lead adding a member', async () => {
    const bytes = await teamActBytes({
      ...common,
      act: 'member_add',
      subject: '01JQZ0000000000000000000CC',
      subjectKeyFpr: fill(0x42),
      scope: null,
      undoes: null,
      undoneBytes: null,
      signerAuthority: 'lead',
    });
    expect(toHex(bytes)).toBe(MEMBER_ADD);
  });

  it('are the bytes the server builds for a Steward taking a folder back', async () => {
    const bytes = await teamActBytes({
      ...common,
      act: 'grant_revoke',
      subject: null,
      subjectKeyFpr: new Uint8Array(32),
      scope: '01JQZ0000000000000000000BB',
      undoes: '01JQZ0000000000000000000KK',
      undoneBytes: utf8("the undone act's own signed bytes"),
      signerAuthority: 'steward',
    });
    expect(toHex(bytes)).toBe(GRANT_REVOKE);
  });
});

// `TEAM_ROLE_TECH_BYTES` and `TEAM_ROLE_RETIRE_BYTES`, from the same script (migration 0071).
const ROLE_TECH = '13000000666174686f6d2f7465616d2f726f6c652f76311a00000030314a515a3030303030303030303030303030303030303041412000000041414141414141414141414141414141414141414141414141414141414141411a00000030314a515a303030303030303030303030303030303030304d4d0400000074656368100000004d61696e74656e616e636520746563680f000000656d657267656e63795f7374617274001a00000030314a515a303030303030303030303030303030303030304444200000004343434343434343434343434343434343434343434343434343434343434343800e80690000000007000000';
const ROLE_RETIRE = '13000000666174686f6d2f7465616d2f726f6c652f76311a00000030314a515a3030303030303030303030303030303030303041412000000041414141414141414141414141414141414141414141414141414141414141411a00000030314a515a303030303030303030303030303030303030304d4d1a00000030314a515a303030303030303030303030303030303030304e4e0a0000004e69676874206465736b00000000011a00000030314a515a303030303030303030303030303030303030304444200000004343434343434343434343434343434343434343434343434343434343434343800e80690000000007000000';

describe('a role definition’s signed bytes', () => {
  const role = {
    organisation: common.organisation,
    rootPubkeyFpr: common.rootPubkeyFpr,
    defId: '01JQZ0000000000000000000MM',
    signer: common.signer,
    signerKeyFpr: common.signerKeyFpr,
    atUnix: common.atUnix,
    authEpoch: common.authEpoch,
  };
  it('are the bytes the server builds for a ready-made role changed', () => {
    expect(toHex(teamRoleBytes({ ...role, role: 'tech', title: 'Maintenance tech', powers: powersText(['emergency_start']), retired: false }))).toBe(ROLE_TECH);
  });
  it('are the bytes the server builds for a Steward’s role retired', () => {
    expect(toHex(teamRoleBytes({ ...role, role: '01JQZ0000000000000000000NN', title: 'Night desk', powers: '', retired: true }))).toBe(ROLE_RETIRE);
  });
  it('writes powers in the server’s order whatever order they were ticked in', () => {
    expect(powersText(['emergency_start', 'assign', 'history'])).toBe('assign,history,emergency_start');
  });
});

const wire = {
  steward: false,
  teams: [
    {
      id: 'T1',
      slug: 'net-ops',
      name: 'Network operations',
      members: [{ account: 'A', name: 'Ana', act: 'X1' }],
      leads: [{ account: 'B', name: 'Ben', act: 'X2' }],
      supervisors: [{ account: 'C', name: 'Cy', act: 'X3' }],
      grants: [
        { act: 'G1', scope: null, capability: 'read' },
        { act: 'G2', scope: 'S1', capability: 'steward' },
      ],
      roles: [{ role: 'tech', account: 'D', name: 'Dee', act: 'X4' }],
      may_staff: true,
    },
  ],
  people: [{ account: 'A', name: 'Ana' }],
  roles: [
    { role: 'lead', title: 'Lead', powers: ['assign', 'members', 'nonsense'], preset: true, retired: false },
    { role: 'tech', title: 'Field engineer', powers: ['emergency_start'], preset: true, retired: false },
  ],
};

describe('the teams list', () => {
  it('reads the server’s answer, and drops a grant that is not Read or Draw', () => {
    const t = parseTeams(utf8(JSON.stringify(wire)));
    expect(t.steward).toBe(false);
    expect(t.people).toEqual([{ account: 'A', name: 'Ana' }]);
    expect(t.teams[0].supervisors[0].name).toBe('Cy');
    expect(t.teams[0].grants).toEqual([{ act: 'G1', scope: null, capability: 'read' }]);
    expect(t.teams[0].mayStaff).toBe(true);
    expect(t.teams[0].roles).toEqual([{ role: 'tech', account: 'D', name: 'Dee', act: 'X4' }]);
    // A power this browser does not know is dropped, never shown as something it is not.
    expect(t.roles[0].powers).toEqual(['assign', 'members']);
    expect(titleOf(t.roles, 'tech')).toBe('Field engineer');
    expect(titleOf(t.roles, 'overseer')).toBe('Supervisor');
  });

  it('reads an answer with no people as none to pick from', () => {
    expect(parseTeams(utf8(JSON.stringify({ steward: true, teams: [] }))).people).toEqual([]);
  });

  it('says who is in, leads and supervises', () => {
    const { teams } = parseTeams(utf8(JSON.stringify(wire)));
    expect(involvedIn(teams, 'A')).toBe(true);
    expect(involvedIn(teams, 'C')).toBe(true);
    expect(involvedIn(teams, 'D')).toBe(true);
    expect(involvedIn(teams, 'Z')).toBe(false);
    expect(throughTeams(teams, 'A').map((x) => x.team.id)).toEqual(['T1']);
    expect(throughTeams(teams, 'B')).toEqual([]);
    expect(ledBy(teams, 'B').leads.map((t) => t.id)).toEqual(['T1']);
    expect(ledBy(teams, 'C').supervises.map((t) => t.id)).toEqual(['T1']);
  });
});

describe('a short name from a name', () => {
  it('is lower case, letters and digits, single hyphens, at most 48', () => {
    expect(slugOf('  Network Operations — London ')).toBe('network-operations-london');
    expect(slugOf('x'.repeat(47) + ' y')).toBe('x'.repeat(47));
    expect(slugOf('!!!')).toBe('');
  });
});

describe('a team’s history', () => {
  it('carries the server’s names for whoever each act names', () => {
    const [line] = parseHistory(
      utf8(JSON.stringify({ acts: [{ id: 'X', act: 'member_add', subject: 'A', role: null, scope: null, capability: null, by: 'K', as: 'steward', at: 1, counts: true }], names: { K: 'Key Maker', A: 'Ana' } })),
    );
    expect(line.byName).toBe('Key Maker');
    expect(line.subjectName).toBe('Ana');
  });
});
