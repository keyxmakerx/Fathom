// Teams (ADR-0081; where they live: ADR-0088, UI-SPEC "Where the new work lives").
//
// One component for both places a team is seen. Steward › Teams is a root Steward's: every
// team, New team, and on a team's page members, roles, folders, rename and delete; and a Roles
// tab, where a role's title and powers are set (migration 0071, card r102 version 2).
// Home › Teams is for someone in, leading or supervising a team: the same page, read-only,
// except that a lead adds and removes members. Every change is signed in this browser
// (`api/teams.ts`); the server checks it again at every use.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { describeError } from '../../api/invitations';
import type { Scope } from '../../api/scopes';
import {
  defineRole,
  doTeamAct,
  POWERS,
  fetchHistory,
  fetchTeams,
  ledBy,
  renameTeam,
  slugOf,
  throughTeams,
  type ActChoice,
  type HistoryLine,
  type Power,
  type RoleChoice,
  type RoleDef,
  type RoleSeat,
  type Team,
  type TeamCapability,
  type TeamGrant,
  type TeamRole,
  type Teams,
  titleOf,
} from '../../api/teams';
import { getSession } from '../../state/sessionState';
import { dateTimeLabel } from '../organisation/model';
import '../organisation/organisation.css';

export type TeamsWhere = 'steward' | 'home';

const WHOLE = '';

/** A folder's words, given the folders this browser knows. */
export function folderWords(scope: string | null, scopes: readonly Pick<Scope, 'scopeId' | 'path' | 'displayName'>[]): string {
  if (scope === null) return 'the whole organisation';
  const s = scopes.find((x) => x.scopeId === scope);
  return s ? s.path || s.displayName : 'a folder you cannot see';
}

export const grantWords = (g: Pick<TeamGrant, 'capability' | 'scope'>, scopes: readonly Pick<Scope, 'scopeId' | 'path' | 'displayName'>[]): string =>
  `${g.capability === 'draw' ? 'Draw' : 'Read'} in ${folderWords(g.scope, scopes)}`;

const PRESET_TITLES: Record<string, string> = { lead: 'Lead', overseer: 'Supervisor', tech: 'Maintenance tech' };

/** The ready-made roles, for a server that sends no definitions. */
const FALLBACK_ROLES: RoleDef[] = [
  { role: 'lead', title: 'Lead', powers: POWERS.map((p) => p.power), preset: true, retired: false },
  { role: 'overseer', title: 'Supervisor', powers: ['assign', 'due_dates', 'approve_plans', 'history'], preset: true, retired: false },
];

const rolesOf = (teams: Teams): RoleDef[] => (teams.roles.length > 0 ? teams.roles : FALLBACK_ROLES);

/** "lead", "a supervisor", "a Night desk": a role's title as it reads mid-sentence. */
export function roleWords(role: TeamRole | null, roles: readonly RoleDef[] = []): string {
  const title = titleOf(roles, role);
  if (role === 'lead' && title === 'Lead') return 'lead';
  const shown = role !== null && PRESET_TITLES[role] === title ? title.toLowerCase() : title;
  return `${/^[aeiou]/i.test(shown) ? 'an' : 'a'} ${shown}`;
}

/** Who holds `role` on `team`, from the holders list, or the older lists for a server that
 * sends none. */
function holders(team: Team, role: TeamRole): RoleSeat[] {
  if (team.roles.length > 0 || (role !== 'lead' && role !== 'overseer')) return team.roles.filter((r) => r.role === role);
  return (role === 'lead' ? team.leads : team.supervisors).map((s) => ({ ...s, role }));
}

const powerWords = (powers: readonly Power[]): string =>
  powers.length === 0 ? 'No powers.' : `Can: ${POWERS.filter((p) => powers.includes(p.power)).map((p) => p.words.charAt(0).toLowerCase() + p.words.slice(1)).join(', ')}.`;

/** One History line in words. `name` turns an account into a name, or "you"; the server's
 * names on the line are used for anyone it does not know. */
export function historyWords(
  line: HistoryLine,
  name: (account: string | null, known?: string | null) => string,
  scopes: readonly Pick<Scope, 'scopeId' | 'path' | 'displayName'>[],
  roles: readonly RoleDef[] = [],
): string {
  const by = name(line.by, line.byName);
  const who = by.charAt(0).toUpperCase() + by.slice(1);
  const them = name(line.subject, line.subjectName);
  switch (line.act) {
    case 'create':
      return `${who} made the team`;
    case 'delete':
      return `${who} deleted the team`;
    case 'member_add':
      return `${who} added ${them}`;
    case 'member_remove':
      return `${who} removed ${them}`;
    case 'role_set':
      return `${who} made ${them} ${roleWords(line.role, roles)}`;
    case 'role_clear':
      return `${who} stopped ${them} being ${roleWords(line.role, roles)}`;
    case 'grant':
      return `${who} let the team ${line.capability === 'draw' ? 'draw' : 'read'} in ${folderWords(line.scope, scopes)}`;
    case 'grant_revoke':
      return `${who} took back the team’s access to ${folderWords(line.scope, scopes)}`;
    default:
      return `${who} changed the team`;
  }
}

export interface TeamsViewProps {
  teams: Teams;
  /** The caller's account. */
  me: string;
  where: TeamsWhere;
  /** Every folder this browser knows, for names. */
  scopes: readonly Scope[];
  /** The folders the caller may give a team (a Steward's); empty on Home. */
  grantable: readonly Scope[];
  open: string | null;
  history: HistoryLine[] | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onOpen: (team: string | null) => void;
  onAct: (choice: ActChoice, done: string) => void;
  onRename: (team: string, slug: string, name: string) => void;
  /** A root Steward sets a role's title and powers, adds one or retires one. */
  onDefineRole: (choice: RoleChoice, done: string) => void;
  /** Which of Teams and Roles a root Steward sees first; Teams unless a test says otherwise. */
  startTab?: 'teams' | 'roles';
}

/** The page, given what the server answered. Separate so a test can render it without a server. */
export function TeamsView(props: TeamsViewProps) {
  const { teams, me, where, open, busy, error, notice, onOpen, onAct } = props;
  const [tab, setTab] = useState<'teams' | 'roles'>(props.startTab ?? 'teams');
  const team = open === null ? null : teams.teams.find((t) => t.id === open) ?? null;
  const notes = (
    <>
      {notice && <p className="org-note" role="status">{notice}</p>}
      {error && (
        <p className="home__error" role="alert">
          {error}
        </p>
      )}
    </>
  );
  if (team) {
    return <TeamPage {...props} team={team} notes={notes} />;
  }
  const mayMake = where === 'steward' && teams.steward;
  const tabs = mayMake && (
    <div className="org-tabs" role="tablist" aria-label="Teams and roles">
      <button type="button" role="tab" className="org-tab" aria-selected={tab === 'teams'} onClick={() => setTab('teams')}>
        Teams
      </button>
      <button type="button" role="tab" className="org-tab" aria-selected={tab === 'roles'} onClick={() => setTab('roles')}>
        Roles
      </button>
    </div>
  );
  if (mayMake && tab === 'roles') {
    return (
      <section className="org-page" data-testid="teams-roles">
        <div className="org-page__title">Teams</div>
        {tabs}
        {notes}
        <RolesView teams={teams} busy={busy} onDefine={props.onDefineRole} />
      </section>
    );
  }
  const mine = (t: Team) => rolesOf(teams).filter((d) => holders(t, d.role).some((s) => s.account === me));
  return (
    <section className="org-page" data-testid={`teams-${where}`}>
      <div className="org-page__title">Teams</div>
      {tabs}
      <p className="org-field__hint">
        {where === 'steward'
          ? 'A team is a group of people given folders together. Whoever joins gets what the team has; whoever leaves loses it. What a lead, supervisor or anyone else in a role may do is set on Roles.'
          : 'The teams you are in, lead or supervise, and the folders each gives its members.'}
      </p>
      {notes}
      {teams.teams.length === 0 ? (
        <p className="home__muted">{mayMake ? 'No teams yet.' : 'You are in no team.'}</p>
      ) : (
        <table className="org-table">
          <thead>
            <tr>
              <th>Team</th>
              <th>Members</th>
              <th>Folders</th>
            </tr>
          </thead>
          <tbody>
            {teams.teams.map((t) => (
              <tr key={t.id}>
                <td>
                  <button type="button" className="org-link" onClick={() => onOpen(t.id)}>
                    {t.name}
                  </button>
                  {mine(t).map((d) => (
                    <span key={d.role} className="org-tag">
                      {d.role === 'lead' && d.title === 'Lead' ? 'you lead' : d.role === 'overseer' && d.title === 'Supervisor' ? 'you supervise' : `you’re ${roleWords(d.role, teams.roles)}`}
                    </span>
                  ))}
                  <div className="org-sub org-mono">{t.slug}</div>
                </td>
                <td>{t.members.length}</td>
                <td>{t.grants.length === 0 ? 'None' : t.grants.map((g) => grantWords(g, props.scopes)).join('; ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {mayMake && <NewTeam busy={busy} onMake={(name, slug) => onAct({ act: 'create', as: 'steward', name, slug }, `Signed. ${name} is made; add its members below.`)} />}
    </section>
  );
}

function NewTeam({ busy, onMake }: { busy: boolean; onMake: (name: string, slug: string) => void }) {
  const [making, setMaking] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const shownSlug = slugTouched ? slug : slugOf(name);
  const okSlug = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(shownSlug) && shownSlug.length <= 48;
  const okName = name.trim().length > 0 && name.trim().length <= 80;
  if (!making) {
    return (
      <div className="org-actions">
        <button type="button" className="org-btn btn-main" onClick={() => setMaking(true)}>
          New team
        </button>
      </div>
    );
  }
  return (
    <form
      className="org-form"
      data-testid="team-new"
      onSubmit={(e) => {
        e.preventDefault();
        if (!okName || !okSlug) return;
        onMake(name.trim(), shownSlug);
        setMaking(false);
        setName('');
        setSlug('');
        setSlugTouched(false);
      }}
    >
      <div className="org-form__title">New team</div>
      <label className="org-field">
        <span className="org-field__label">Name</span>
        <input className="org-input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Network operations" />
      </label>
      <label className="org-field">
        <span className="org-field__label">Short name</span>
        <input
          className="org-input org-mono"
          value={shownSlug}
          maxLength={48}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
        />
        <span className="org-field__hint">Lower-case letters, digits and single hyphens. It names the team in the history.</span>
      </label>
      <p className="org-note">You sign this with this browser’s key. It is in the organisation’s history.</p>
      <div className="org-actions">
        <button type="submit" className="org-btn btn-main" disabled={busy || !okName || !okSlug}>
          {busy ? 'Signing…' : 'Sign and make the team'}
        </button>
        <button type="button" className="org-btn" onClick={() => setMaking(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function TeamPage({ team, teams, me, where, scopes, grantable, history, busy, onOpen, onAct, onRename, notes }: TeamsViewProps & { team: Team; notes: ReactNode }) {
  const steward = where === 'steward' && teams.steward;
  const as: ActChoice['as'] = teams.steward ? 'steward' : 'lead';
  const mayStaff = team.mayStaff;
  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of teams.people) m.set(p.account, p.name);
    for (const t of teams.teams) for (const s of [...t.members, ...t.leads, ...t.supervisors, ...t.roles]) if (s.name) m.set(s.account, s.name);
    return m;
  }, [teams]);
  const name = (account: string | null, known?: string | null) =>
    account === null ? 'someone' : account === me ? 'you' : names.get(account) || known || 'someone who has left';
  const Name = (account: string) => {
    const n = name(account);
    return n.charAt(0).toUpperCase() + n.slice(1);
  };
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [newName, setNewName] = useState(team.name);
  const [newSlug, setNewSlug] = useState(team.slug);

  const base = { team: team.id, as };
  const memberIds = new Set(team.members.map((s) => s.account));
  // A lead never adds or removes themselves (T2): only a Steward can.
  const mayTouch = (account: string) => mayStaff && (as === 'steward' || account !== me);

  return (
    <section className="org-page" data-testid="team-page">
      <button type="button" className="org-link" onClick={() => onOpen(null)}>
        ← Teams
      </button>
      <div className="org-page__title">{team.name}</div>
      <div className="org-sub org-mono">{team.slug}</div>
      {notes}

      <div className="home__label">Members</div>
      {team.members.length === 0 && <p className="home__muted">No members yet.</p>}
      <ul className="org-rows" data-testid="team-members">
        {team.members.map((s) => (
          <li key={s.act} className="org-row">
            <div className="org-row__main">
              <div>
                <strong>{Name(s.account)}</strong>
                {rolesOf(teams)
                  .filter((d) => holders(team, d.role).some((h) => h.account === s.account))
                  .map((d) => (
                    <span key={d.role} className="org-tag">
                      {d.title.toLowerCase()}
                    </span>
                  ))}
              </div>
            </div>
            <div className="org-row__actions">
              {mayTouch(s.account) && (
                <button
                  type="button"
                  className="org-btn"
                  disabled={busy}
                  onClick={() => onAct({ ...base, act: 'member_remove', subject: s.account, undoes: s.act }, `Signed. ${Name(s.account)} has left ${team.name} and lost what it gives.`)}
                >
                  Remove
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {mayStaff && (
        <PickPerson
          label="Add a member"
          button="Sign and add"
          busy={busy}
          people={teams.people.filter((p) => !memberIds.has(p.account) && mayTouch(p.account))}
          testId="team-add-member"
          onPick={(account) => onAct({ ...base, act: 'member_add', subject: account }, `Signed. ${Name(account)} is in ${team.name} and has what it gives.`)}
        />
      )}

      <TeamRoles
        team={team}
        teams={teams}
        steward={steward}
        busy={busy}
        name={Name}
        onAct={(choice, done) => onAct({ ...base, ...choice }, done)}
      />

      <div className="home__label">Folders</div>
      {team.grants.length === 0 && <p className="home__muted">None. Members get nothing through this team yet.</p>}
      <ul className="org-rows" data-testid="team-grants">
        {team.grants.map((g) => (
          <li key={g.act} className="org-row">
            <div className="org-row__main">
              <strong>{grantWords(g, scopes)}</strong>
            </div>
            <div className="org-row__actions">
              {steward && (
                <button
                  type="button"
                  className="org-btn"
                  disabled={busy}
                  onClick={() => onAct({ ...base, act: 'grant_revoke', scope: g.scope, undoes: g.act }, `Signed. ${team.name}’s members no longer have that through the team.`)}
                >
                  Take back
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {steward && (
        <GiveFolder
          busy={busy}
          grantable={grantable}
          onGive={(scope, capability) =>
            onAct({ ...base, act: 'grant', scope, capability }, `Signed. Every member of ${team.name} may ${capability} in ${folderWords(scope, scopes)} now.`)
          }
        />
      )}

      {steward && (
        <div className="org-box" data-testid="team-manage">
          {!renaming && !deleting && (
            <div className="org-actions">
              <button type="button" className="org-btn" onClick={() => setRenaming(true)}>
                Rename
              </button>
              <button type="button" className="org-btn" onClick={() => setDeleting(true)}>
                Delete the team
              </button>
            </div>
          )}
          {renaming && (
            <form
              className="org-form"
              onSubmit={(e) => {
                e.preventDefault();
                onRename(team.id, newSlug, newName.trim());
                setRenaming(false);
              }}
            >
              <label className="org-field">
                <span className="org-field__label">Name</span>
                <input className="org-input" value={newName} maxLength={80} onChange={(e) => setNewName(e.target.value)} />
              </label>
              <label className="org-field">
                <span className="org-field__label">Short name</span>
                <input className="org-input org-mono" value={newSlug} maxLength={48} onChange={(e) => setNewSlug(e.target.value)} />
              </label>
              <div className="org-actions">
                <button type="submit" className="org-btn btn-main" disabled={busy || newName.trim() === '' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(newSlug)}>
                  Save
                </button>
                <button type="button" className="org-btn" onClick={() => setRenaming(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
          {deleting && (
            <>
              <p className="org-note">
                Everyone in {team.name} loses what the team gives them at once. Access given to them one by one stays. The team’s history is kept.
              </p>
              <div className="org-actions">
                <button
                  type="button"
                  className="org-btn btn-main"
                  disabled={busy}
                  onClick={() => {
                    setDeleting(false);
                    onAct({ ...base, act: 'delete' }, `Signed. ${team.name} is deleted.`);
                  }}
                >
                  {busy ? 'Signing…' : 'Sign and delete'}
                </button>
                <button type="button" className="org-btn" onClick={() => setDeleting(false)}>
                  Keep it
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="home__label">History</div>
      {history === null ? (
        <p className="home__muted">Loading…</p>
      ) : (
        <ul className="org-review" data-testid="team-history">
          {history.map((line) => (
            <li key={line.id}>
              <span className="org-sub">{dateTimeLabel(line.at)}</span> {historyWords(line, name, scopes, teams.roles)}
              {line.as === 'lead' && <span className="org-tag">by their role</span>}
              {!line.counts && <span className="org-tag">does not count</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A team's roles: who holds what, and for a Steward the picker that gives one. */
function TeamRoles({
  team,
  teams,
  steward,
  busy,
  name,
  onAct,
}: {
  team: Team;
  teams: Teams;
  steward: boolean;
  busy: boolean;
  name: (account: string) => string;
  onAct: (choice: Omit<ActChoice, 'as' | 'team'>, done: string) => void;
}) {
  const defs = rolesOf(teams);
  const seats = defs.flatMap((d) => holders(team, d.role).map((s) => ({ seat: s, def: d })));
  const live = defs.filter((d) => !d.retired);
  const [account, setAccount] = useState('');
  const [role, setRole] = useState(live[0]?.role ?? '');
  const taken = new Set(holders(team, role).map((s) => s.account));
  const chosen = defs.find((d) => d.role === role) ?? null;
  return (
    <>
      <div className="home__label">Roles</div>
      {steward && <p className="org-field__hint">What each role may do is set on the Roles tab. A role never gives access to a folder.</p>}
      {seats.length === 0 && <p className="home__muted">Nobody holds a role in this team.</p>}
      <ul className="org-rows" data-testid="team-roles">
        {seats.map(({ seat: s, def: d }) => (
          <li key={s.act} className="org-row">
            <div className="org-row__main">
              <div>
                <strong>{name(s.account)}</strong>
                <span className="org-tag">{d.title}</span>
                {d.retired && <span className="org-tag">retired</span>}
              </div>
              <div className="org-sub">{powerWords(d.retired ? [] : d.powers)}</div>
            </div>
            <div className="org-row__actions">
              {steward && (
                <button
                  type="button"
                  className="org-btn"
                  disabled={busy}
                  onClick={() => onAct({ act: 'role_clear', subject: s.account, role: d.role, undoes: s.act }, `Signed. ${name(s.account)} is no longer ${roleWords(d.role, teams.roles)}.`)}
                >
                  Stop
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {steward && live.length > 0 && teams.people.length > 0 && (
        <form
          className="org-inline"
          data-testid="team-set-role"
          onSubmit={(e) => {
            e.preventDefault();
            if (account === '' || chosen === null) return;
            onAct({ act: 'role_set', subject: account, role }, `Signed. ${name(account)} is ${roleWords(role, teams.roles)} now.`);
            setAccount('');
          }}
        >
          <label className="org-field">
            <span className="org-field__label">Give someone a role</span>
            <select className="org-input" value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="">Choose someone…</option>
              {teams.people
                .filter((p) => !taken.has(p.account))
                .map((p) => (
                  <option key={p.account} value={p.account}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="org-field">
            <span className="org-field__label">As</span>
            <select className="org-input" value={role} onChange={(e) => setRole(e.target.value)}>
              {live.map((d) => (
                <option key={d.role} value={d.role}>
                  {d.title}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="org-btn" disabled={busy || account === ''}>
            Sign
          </button>
        </form>
      )}
    </>
  );
}

/** Steward › Teams › Roles: every role with its powers, and the form that changes one. */
export function RolesView({ teams, busy, onDefine, startEditing = null }: { teams: Teams; busy: boolean; onDefine: (choice: RoleChoice, done: string) => void; startEditing?: string | null }) {
  const [editing, setEditing] = useState<string | null>(startEditing);
  const roles = rolesOf(teams);
  const holding = (role: string) => new Set(teams.teams.flatMap((t) => holders(t, role).map((s) => s.account))).size;
  const current = editing === null ? null : editing === NEW_ROLE ? NEW_ROLE : roles.find((d) => d.role === editing) ?? null;
  return (
    <>
      <p className="org-field__hint">
        A role is what someone may do in a team’s work. Lead, Supervisor and Maintenance tech come ready-made; rename them, change their powers, or add your own. No role gives access to a folder:
        only folders given to a person or a team do that.
      </p>
      <div className="org-scroll">
        <table className="org-table" data-testid="roles-table">
          <thead>
            <tr>
              <th>Role</th>
              {POWERS.map((p) => (
                <th key={p.power}>{p.words}</th>
              ))}
              <th>Held by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {roles
              .filter((d) => !d.retired)
              .map((d) => (
                <tr key={d.role}>
                  <td>
                    <strong>{d.title}</strong>
                  </td>
                  {POWERS.map((p) => (
                    <td key={p.power} aria-label={d.powers.includes(p.power) ? 'yes' : 'no'}>
                      {d.powers.includes(p.power) ? '✓' : '·'}
                    </td>
                  ))}
                  <td>{holding(d.role)}</td>
                  <td>
                    <button type="button" className="org-btn" disabled={busy} onClick={() => setEditing(d.role)}>
                      Change
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {current === null ? (
        <div className="org-actions">
          <button type="button" className="org-btn btn-main" disabled={busy} onClick={() => setEditing(NEW_ROLE)}>
            New role
          </button>
        </div>
      ) : (
        <RoleForm
          key={current === NEW_ROLE ? NEW_ROLE : current.role}
          def={current === NEW_ROLE ? null : current}
          held={current === NEW_ROLE ? 0 : holding(current.role)}
          taken={roles.filter((d) => !d.retired && (current === NEW_ROLE || d.role !== current.role)).map((d) => d.title.toLowerCase())}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={(choice, done) => {
            setEditing(null);
            onDefine(choice, done);
          }}
        />
      )}
    </>
  );
}

const NEW_ROLE = '\u0000new';

function RoleForm({
  def,
  held,
  taken,
  busy,
  onCancel,
  onSave,
}: {
  def: RoleDef | null;
  held: number;
  taken: readonly string[];
  busy: boolean;
  onCancel: () => void;
  onSave: (choice: RoleChoice, done: string) => void;
}) {
  const [title, setTitle] = useState(def?.title ?? '');
  const [powers, setPowers] = useState<Power[]>(def?.powers ?? []);
  const [retiring, setRetiring] = useState(false);
  const trimmed = title.trim();
  const clash = taken.includes(trimmed.toLowerCase());
  const ok = trimmed.length > 0 && trimmed.length <= 40 && !clash;
  const toggle = (p: Power) => setPowers((now) => (now.includes(p) ? now.filter((x) => x !== p) : [...now, p]));
  return (
    <form
      className="org-form"
      data-testid="role-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        onSave({ role: def?.role, title: trimmed, powers, retired: false }, def ? `Signed. ${trimmed} is changed for everyone who holds it.` : `Signed. ${trimmed} is made; give it to people on a team’s page.`);
      }}
    >
      <div className="org-form__title">{def ? `Change ${def.title}` : 'New role'}</div>
      <label className="org-field">
        <span className="org-field__label">Title</span>
        <input className="org-input" value={title} maxLength={40} onChange={(e) => setTitle(e.target.value)} placeholder="Night desk" />
        {clash && <span className="org-field__hint">Another role already has that title.</span>}
      </label>
      <fieldset className="org-field">
        <legend className="org-field__label">May</legend>
        {POWERS.map((p) => (
          <label key={p.power} className="org-radio">
            <input type="checkbox" checked={powers.includes(p.power)} onChange={() => toggle(p.power)} /> {p.words}
          </label>
        ))}
      </fieldset>
      <p className="org-note">
        {def && held > 0 ? `${held} ${held === 1 ? 'person holds' : 'people hold'} this role; the change applies to them from now on. What they already did stands. ` : ''}
        You sign this with this browser’s key. It is in the organisation’s history.
      </p>
      <div className="org-actions">
        <button type="submit" className="org-btn btn-main" disabled={busy || !ok}>
          {busy ? 'Signing…' : 'Sign and save'}
        </button>
        <button type="button" className="org-btn" onClick={onCancel}>
          Cancel
        </button>
        {def && !def.preset && !retiring && (
          <button type="button" className="org-btn" onClick={() => setRetiring(true)}>
            Retire this role
          </button>
        )}
      </div>
      {def && retiring && (
        <>
          <p className="org-note">Everyone holding {def.title} loses its powers at once. It can’t be brought back; make a new role instead.</p>
          <div className="org-actions">
            <button
              type="button"
              className="org-btn btn-main"
              disabled={busy}
              onClick={() => onSave({ role: def.role, title: def.title, powers: def.powers, retired: true }, `Signed. ${def.title} is retired.`)}
            >
              Sign and retire
            </button>
            <button type="button" className="org-btn" onClick={() => setRetiring(false)}>
              Keep it
            </button>
          </div>
        </>
      )}
    </form>
  );
}

function PickPerson({ label, button, busy, people, testId, onPick }: { label: string; button: string; busy: boolean; people: Teams['people']; testId: string; onPick: (account: string) => void }) {
  const [account, setAccount] = useState('');
  if (people.length === 0) return null;
  return (
    <form
      className="org-inline"
      data-testid={testId}
      onSubmit={(e) => {
        e.preventDefault();
        if (account === '') return;
        onPick(account);
        setAccount('');
      }}
    >
      <label className="org-field">
        <span className="org-field__label">{label}</span>
        <select className="org-input" value={account} onChange={(e) => setAccount(e.target.value)}>
          <option value="">Choose someone…</option>
          {people.map((p) => (
            <option key={p.account} value={p.account}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="org-btn" disabled={busy || account === ''}>
        {button}
      </button>
    </form>
  );
}

function GiveFolder({ busy, grantable, onGive }: { busy: boolean; grantable: readonly Scope[]; onGive: (scope: string | null, capability: TeamCapability) => void }) {
  const [scope, setScope] = useState<string>(WHOLE);
  const [capability, setCapability] = useState<TeamCapability>('read');
  return (
    <form
      className="org-inline"
      data-testid="team-give"
      onSubmit={(e) => {
        e.preventDefault();
        onGive(scope === WHOLE ? null : scope, capability);
      }}
    >
      <label className="org-field">
        <span className="org-field__label">Let the team</span>
        <select className="org-input" value={capability} onChange={(e) => setCapability(e.target.value as TeamCapability)}>
          <option value="read">Read</option>
          <option value="draw">Draw</option>
        </select>
      </label>
      <label className="org-field">
        <span className="org-field__label">In</span>
        <select className="org-input" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value={WHOLE}>The whole organisation</option>
          {grantable.map((s) => (
            <option key={s.scopeId} value={s.scopeId}>
              {s.path || s.displayName}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="org-btn" disabled={busy}>
        Sign and give
      </button>
    </form>
  );
}

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: Teams };

/** Loads and drives `TeamsView`. */
export function TeamsPage({ organisation, where, scopes, grantable = [] }: { organisation: string; where: TeamsWhere; scopes: readonly Scope[]; grantable?: readonly Scope[] }) {
  const [teams, setTeams] = useState<Load>({ status: 'loading' });
  const [open, setOpen] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryLine[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const me = getSession()?.accountId ?? '';

  const reload = useCallback(
    () =>
      fetchTeams(organisation).then(
        (value) => setTeams({ status: 'ready', value }),
        (e: unknown) => setTeams({ status: 'error', message: describeError(e) }),
      ),
    [organisation],
  );
  useEffect(() => {
    setTeams({ status: 'loading' });
    setOpen(null);
    void reload();
  }, [reload]);
  const loadHistory = useCallback(
    (team: string) => {
      setHistory(null);
      fetchHistory(organisation, team).then(setHistory, () => setHistory([]));
    },
    [organisation],
  );

  async function run(work: () => Promise<void>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      setNotice(done);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (teams.status === 'loading') return <p className="home__muted">Loading…</p>;
  if (teams.status === 'error') {
    return (
      <section className="org-page">
        <div className="org-page__title">Teams</div>
        <p className="home__error" role="alert">
          {teams.message}
        </p>
      </section>
    );
  }
  return (
    <TeamsView
      teams={teams.value}
      me={me}
      where={where}
      scopes={scopes}
      grantable={grantable}
      open={open}
      history={history}
      busy={busy}
      error={error}
      notice={notice}
      onOpen={(team) => {
        setError(null);
        setNotice(null);
        setOpen(team);
        if (team) loadHistory(team);
      }}
      onAct={(choice, done) =>
        void run(async () => {
          const result = await doTeamAct(organisation, choice);
          await reload();
          if (choice.act === 'delete') setOpen(null);
          else {
            setOpen(result.team);
            loadHistory(result.team);
          }
        }, done)
      }
      onDefineRole={(choice, done) =>
        void run(async () => {
          await defineRole(organisation, choice);
          await reload();
        }, done)
      }
      onRename={(team, slug, name) =>
        void run(async () => {
          await renameTeam(organisation, team, slug, name);
          await reload();
          loadHistory(team);
        }, 'Saved. The new name is in the organisation’s history.')
      }
    />
  );
}

/** Steward › People › a person: the teams they are in and what each gives, and the ones they
 * lead or supervise. */
export function ThroughTeams({ organisation, account, scopes }: { organisation: string; account: string; scopes: readonly Scope[] }) {
  const [teams, setTeams] = useState<Team[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchTeams(organisation).then(
      (t) => {
        if (!cancelled) setTeams(t.teams);
      },
      () => {
        if (!cancelled) setTeams([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [organisation]);
  if (teams === null) return null;
  return <ThroughTeamsView teams={teams} account={account} scopes={scopes} />;
}

export function ThroughTeamsView({ teams, account, scopes }: { teams: readonly Team[]; account: string; scopes: readonly Scope[] }) {
  const inTeams = throughTeams(teams, account);
  const { leads, supervises } = ledBy(teams, account);
  return (
    <div data-testid="person-through-teams">
      <div className="home__label">Through teams</div>
      {inTeams.length === 0 ? (
        <p className="home__muted">In no team.</p>
      ) : (
        <ul className="org-rows">
          {inTeams.map(({ team: t, grants }) => (
            <li key={t.id} className="org-row">
              <div className="org-row__main">
                <strong>{t.name}</strong>
                <div className="org-sub">{grants.length === 0 ? 'Gives nothing yet.' : grants.map((g) => grantWords(g, scopes)).join('; ')}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {leads.length > 0 && <p className="org-note">Leads {leads.map((t) => t.name).join(', ')}.</p>}
      {supervises.length > 0 && <p className="org-note">Supervises {supervises.map((t) => t.name).join(', ')}.</p>}
    </div>
  );
}
