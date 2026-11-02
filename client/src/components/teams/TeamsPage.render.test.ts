import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { HistoryLine, Teams } from '../../api/teams';
import { folder } from '../organisation/fixtures';
import { historyWords, ThroughTeamsView, TeamsView, type TeamsViewProps } from './TeamsPage';

// What each Teams screen shows on first draw. The signing is `api/teams.ts`'s, tested there.

const noop = () => undefined;
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const scopes = [folder('S1', 'LON1')];

const teams = (over: Partial<Teams> = {}): Teams => ({
  steward: true,
  teams: [
    {
      id: 'T1',
      slug: 'net-ops',
      name: 'Network operations',
      members: [
        { account: 'A', name: 'Ana', act: 'M1' },
        { account: 'B', name: 'Ben', act: 'M2' },
      ],
      leads: [{ account: 'B', name: 'Ben', act: 'L1' }],
      supervisors: [{ account: 'C', name: 'Cy', act: 'O1' }],
      grants: [{ act: 'G1', scope: 'S1', capability: 'draw' }],
      mayStaff: true,
    },
  ],
  people: [
    { account: 'A', name: 'Ana' },
    { account: 'B', name: 'Ben' },
    { account: 'C', name: 'Cy' },
    { account: 'D', name: 'Dee' },
  ],
  ...over,
});

const props = (over: Partial<TeamsViewProps> = {}): TeamsViewProps => ({
  teams: teams(),
  me: 'S',
  where: 'steward',
  scopes,
  grantable: scopes,
  open: null,
  history: null,
  busy: false,
  error: null,
  notice: null,
  onOpen: noop,
  onAct: noop,
  onRename: noop,
  ...over,
});

describe('Steward › Teams', () => {
  it('lists every team with its members and folders, and offers New team', () => {
    const out = html(createElement(TeamsView, props()));
    expect(out).toContain('Network operations');
    expect(out).toContain('net-ops');
    expect(out).toContain('Draw in LON1');
    expect(out).toContain('New team');
  });

  it('opens a team with its members, lead, supervisor, folders and every Steward action', () => {
    const out = html(createElement(TeamsView, props({ open: 'T1', history: [] })));
    for (const words of ['Members', 'Leads', 'Supervisors', 'Folders', 'History', 'Ana', 'Ben', 'Cy', 'Draw in LON1', 'Take back', 'Rename', 'Delete the team', 'Make someone lead', 'Make someone a supervisor', 'Sign and give', 'Add a member']) {
      expect(out).toContain(words);
    }
    // Only Dee is not a member yet: the only one offered.
    const add = out.slice(out.indexOf('data-testid="team-add-member"'));
    expect(add.slice(0, add.indexOf('</form>'))).toContain('Dee');
    expect(add.slice(0, add.indexOf('</form>'))).not.toContain('>Ana<');
  });
});

describe('Home › Teams', () => {
  it('says so when the person is in no team, and never offers New team', () => {
    const out = html(createElement(TeamsView, props({ where: 'home', teams: teams({ steward: false, teams: [], people: [] }) })));
    expect(out).toContain('You are in no team.');
    expect(out).not.toContain('New team');
  });

  it('lets a lead add and remove members other than themselves, and nothing else', () => {
    const out = html(createElement(TeamsView, props({ where: 'home', me: 'B', open: 'T1', history: [], teams: teams({ steward: false }) })));
    const members = out.slice(out.indexOf('data-testid="team-members"'), out.indexOf('data-testid="team-lead"'));
    expect(members.match(/>Remove</g)?.length).toBe(1);
    expect(out).toContain('Add a member');
    for (const words of ['Take back', 'Rename', 'Delete the team', 'Make someone lead', 'Sign and give', '>Stop<']) expect(out).not.toContain(words);
  });

  it('is read-only to a member who does not lead', () => {
    const t = teams({ steward: false, people: [] });
    t.teams[0].mayStaff = false;
    const out = html(createElement(TeamsView, props({ where: 'home', me: 'A', open: 'T1', history: [], teams: t })));
    expect(out).not.toContain('>Remove<');
    expect(out).not.toContain('Add a member');
  });
});

describe('a team’s History', () => {
  const line = (over: Partial<HistoryLine>): HistoryLine => ({ id: 'X', act: 'member_add', subject: 'A', role: null, scope: null, capability: null, by: 'B', as: 'lead', at: 1_770_000_000, counts: true, ...over });
  const name = (a: string | null) => ({ A: 'Ana', B: 'Ben' } as Record<string, string>)[a ?? ''] ?? 'someone';

  it('says each act in words', () => {
    expect(historyWords(line({}), name, scopes)).toBe('Ben added Ana');
    expect(historyWords(line({ act: 'role_set', role: 'overseer' }), name, scopes)).toBe('Ben made Ana a supervisor');
    expect(historyWords(line({ act: 'role_clear', role: 'lead' }), name, scopes)).toBe('Ben stopped Ana being lead');
    expect(historyWords(line({ act: 'grant', subject: null, scope: 'S1', capability: 'read' }), name, scopes)).toBe('Ben let the team read in LON1');
    expect(historyWords(line({ act: 'grant_revoke', subject: null, scope: null }), name, scopes)).toBe('Ben took back the team’s access to the whole organisation');
  });

  it('marks an act that no longer counts', () => {
    const out = html(createElement(TeamsView, props({ open: 'T1', history: [line({ counts: false })] })));
    expect(out).toContain('does not count');
    expect(out).toContain('as lead');
  });
});

describe('Steward › People › a person: Through teams', () => {
  it('lists the teams they are in with what each gives, and what they lead or supervise', () => {
    const out = html(createElement(ThroughTeamsView, { teams: teams().teams, account: 'B', scopes }));
    expect(out).toContain('Through teams');
    expect(out).toContain('Network operations');
    expect(out).toContain('Draw in LON1');
    expect(out).toContain('Leads Network operations.');
  });

  it('says so when they are in no team', () => {
    const out = html(createElement(ThroughTeamsView, { teams: teams().teams, account: 'C', scopes }));
    expect(out).toContain('In no team.');
    expect(out).toContain('Supervises Network operations.');
  });
});
