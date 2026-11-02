// Teams (ADR-0081). Wire shapes are `design_api/teams_routes.rs`. Every change to a team is
// signed here with this browser's enrolled key: the server fixes the bytes, this file rebuilds
// them from the person's own choice and refuses to sign if the two differ, as `share.ts` does
// for a grant.

import { concatBytes, fromHex, lp, toHex, u32LE, u64LE, utf8 } from '../crypto/bytes';
import { signMessage } from '../crypto/keys';
import { getSession } from '../state/sessionState';
import { body } from './fieldDefinitions';
import { arrayOf, asRec, bool, int, jsonObject, optStr, sameBytes, str, type Rec } from './json';
import { NoSigningKeyHere, ownKeyFingerprint, signingKey } from './share';
import { signedFetch } from './signedFetch';

export type TeamAct = 'create' | 'delete' | 'member_add' | 'member_remove' | 'role_set' | 'role_clear' | 'grant' | 'grant_revoke';
/** `overseer` is the wire word; the screens say Supervisor (ADR-0081 decision 3). */
export type TeamRole = 'lead' | 'overseer';
export type TeamCapability = 'read' | 'draw';

export interface Seat {
  account: string;
  name: string;
  /** The act that put them there, which a removal names. */
  act: string;
}

export interface TeamGrant {
  act: string;
  /** `null` is the whole organisation. */
  scope: string | null;
  capability: TeamCapability;
}

export interface Team {
  id: string;
  slug: string;
  name: string;
  members: Seat[];
  leads: Seat[];
  supervisors: Seat[];
  grants: TeamGrant[];
  /** The caller may add and remove members: a Steward of the organisation, or this team's lead. */
  mayStaff: boolean;
}

export interface Teams {
  /** The caller is a Steward of the whole organisation: sees every team and may change any. */
  steward: boolean;
  teams: Team[];
  /** The organisation's people to pick from, for a caller who may staff some team; else empty. */
  people: { account: string; name: string }[];
}

export interface HistoryLine {
  id: string;
  act: TeamAct;
  subject: string | null;
  role: TeamRole | null;
  scope: string | null;
  capability: TeamCapability | null;
  by: string;
  as: 'steward' | 'lead';
  at: number;
  /** Its signature and its signer's authority check now. */
  counts: boolean;
  /** Display names from the server, so a member who is not a Steward can read the line. */
  byName: string | null;
  subjectName: string | null;
}

const base = (organisation: string) => `/organisations/${encodeURIComponent(organisation)}/teams`;

function seats(rec: Rec, key: string, what: string): Seat[] {
  return arrayOf(rec, key, what).map((entry, i) => {
    const s = asRec(entry, `${what} ${key} ${i}`);
    return { account: str(s, 'account', what), name: str(s, 'name', what), act: str(s, 'act', what) };
  });
}

const capabilityOf = (v: unknown): TeamCapability | null => (v === 'read' || v === 'draw' ? v : null);

export function parseTeams(bytes: Uint8Array): Teams {
  const r = jsonObject(bytes, 'teams');
  return {
    steward: r.steward === true,
    teams: arrayOf(r, 'teams', 'teams').map((entry, i): Team => {
      const what = `team ${i}`;
      const t = asRec(entry, what);
      return {
        id: str(t, 'id', what),
        slug: str(t, 'slug', what),
        name: str(t, 'name', what),
        members: seats(t, 'members', what),
        leads: seats(t, 'leads', what),
        supervisors: seats(t, 'supervisors', what),
        grants: arrayOf(t, 'grants', what).flatMap((g) => {
          const row = asRec(g, what);
          const capability = capabilityOf(row.capability);
          return capability ? [{ act: str(row, 'act', what), scope: optStr(row, 'scope', what), capability }] : [];
        }),
        mayStaff: bool(t, 'may_staff', what),
      };
    }),
    people: (Array.isArray(r.people) ? r.people : []).map((entry, i) => {
      const p = asRec(entry, `person ${i}`);
      return { account: str(p, 'account', 'person'), name: str(p, 'name', 'person') };
    }),
  };
}

export async function fetchTeams(organisation: string): Promise<Teams> {
  return parseTeams(await signedFetch('GET', base(organisation)));
}

export function parseHistory(bytes: Uint8Array): HistoryLine[] {
  const r = jsonObject(bytes, 'history');
  const names = r.names && typeof r.names === 'object' && !Array.isArray(r.names) ? (r.names as Rec) : {};
  const nameOf = (account: string | null): string | null => (account !== null && typeof names[account] === 'string' ? (names[account] as string) : null);
  return arrayOf(r, 'acts', 'history').map((entry, i) => {
    const what = `act ${i}`;
    const a = asRec(entry, what);
    const role = a.role === 'lead' || a.role === 'overseer' ? a.role : null;
    return {
      id: str(a, 'id', what),
      act: str(a, 'act', what) as TeamAct,
      subject: optStr(a, 'subject', what),
      role,
      scope: optStr(a, 'scope', what),
      capability: capabilityOf(a.capability),
      by: str(a, 'by', what),
      as: a.as === 'lead' ? 'lead' : 'steward',
      at: int(a, 'at', what),
      counts: a.counts === true,
      byName: nameOf(str(a, 'by', what)),
      subjectName: nameOf(optStr(a, 'subject', what)),
    };
  });
}

export async function fetchHistory(organisation: string, team: string): Promise<HistoryLine[]> {
  return parseHistory(await signedFetch('GET', `${base(organisation)}/${encodeURIComponent(team)}/history`));
}

/** `authority::team_act_bytes`, laid out from `docs/TEAMS-ATTACK-ROUND.md` T5 and pinned by
 * the same vectors as `tests/authority_vectors.rs`. */
export async function teamActBytes(f: {
  organisation: string;
  rootPubkeyFpr: Uint8Array;
  actId: string;
  team: string;
  act: string;
  subject: string | null;
  subjectKeyFpr: Uint8Array;
  role: string | null;
  scope: string | null;
  capability: string | null;
  undoes: string | null;
  undoneBytes: Uint8Array | null;
  signer: string;
  signerKeyFpr: Uint8Array;
  signerAuthority: string;
  atUnix: number;
  authEpoch: number;
}): Promise<Uint8Array> {
  const undoneHash = f.undoneBytes
    ? new Uint8Array(await crypto.subtle.digest('SHA-256', f.undoneBytes as BufferSource))
    : new Uint8Array(0);
  return concatBytes(
    lp(utf8('fathom/team/act/v1')),
    lp(utf8(f.organisation)),
    lp(f.rootPubkeyFpr),
    lp(utf8(f.actId)),
    lp(utf8(f.team)),
    lp(utf8(f.act)),
    lp(utf8(f.subject ?? '')),
    lp(f.subjectKeyFpr),
    lp(utf8(f.role ?? '')),
    lp(utf8(f.scope ?? '')),
    lp(utf8(f.capability ?? '')),
    lp(utf8(f.undoes ?? '')),
    lp(undoneHash),
    lp(utf8(f.signer)),
    lp(f.signerKeyFpr),
    lp(utf8(f.signerAuthority)),
    u64LE(f.atUnix),
    u32LE(f.authEpoch),
  );
}

export interface ActChoice {
  act: TeamAct;
  /** Act as a Steward of the organisation, or as this team's lead. */
  as: 'steward' | 'lead';
  team?: string;
  subject?: string;
  role?: TeamRole;
  scope?: string | null;
  capability?: TeamCapability;
  undoes?: string;
  /** For `create`: the new team's slug and name. */
  slug?: string;
  name?: string;
}

const textOf = (r: Rec, key: string): string | null => (typeof r[key] === 'string' ? (r[key] as string) : null);

/** The proposal must be exactly the act chosen: every field the person chose comes back
 * unchanged, the signer is this person with this browser's key. Only then are its bytes
 * rebuilt here; the server's own `bytes` must match them byte for byte. Undo acts carry the
 * hash of the undone act's bytes, which this browser cannot rebuild, so for them the bytes
 * are checked field by field around that hash instead. */
async function checkedBytes(organisation: string, choice: ActChoice, proposal: Rec, signer: string, keyFpr: Uint8Array): Promise<Uint8Array> {
  const same = (key: string, want: string | null | undefined) => textOf(proposal, key) === (want ?? null);
  if (
    !same('act', choice.act) ||
    !same('as', choice.as) ||
    (choice.team !== undefined && !same('team', choice.team)) ||
    !same('subject', choice.subject) ||
    !same('role', choice.role) ||
    !same('scope', choice.scope ?? null) ||
    !same('capability', choice.capability) ||
    !same('undoes', choice.undoes) ||
    !same('signer', signer) ||
    !same('signer_key_fpr', toHex(keyFpr))
  ) {
    throw new Error('The server proposed a change that is not the one you chose, so it was not signed.');
  }
  const atUnix = int(proposal, 'at', 'proposal');
  const authEpoch = int(proposal, 'auth_epoch', 'proposal');
  const facts = {
    organisation,
    rootPubkeyFpr: fromHex(str(proposal, 'root_fpr', 'proposal')),
    actId: str(proposal, 'act_id', 'proposal'),
    team: str(proposal, 'team', 'proposal'),
    act: choice.act,
    subject: choice.subject ?? null,
    subjectKeyFpr: fromHex(str(proposal, 'subject_key_fpr', 'proposal')),
    role: choice.role ?? null,
    scope: choice.scope ?? null,
    capability: choice.capability ?? null,
    undoes: choice.undoes ?? null,
    signer,
    signerKeyFpr: keyFpr,
    signerAuthority: choice.as,
    atUnix,
    authEpoch,
  };
  const sent = fromHex(str(proposal, 'bytes', 'proposal'));
  if (choice.undoes === undefined) {
    const local = await teamActBytes({ ...facts, undoneBytes: null });
    if (!sameBytes(local, sent)) throw new Error('The server proposed bytes that are not the change you chose, so they were not signed.');
    return local;
  }
  // Everything before the undone hash, and everything after it, must be exactly ours.
  const withEmpty = await teamActBytes({ ...facts, undoneBytes: null });
  const tail = concatBytes(lp(utf8(signer)), lp(keyFpr), lp(utf8(choice.as)), u64LE(atUnix), u32LE(authEpoch));
  const head = withEmpty.subarray(0, withEmpty.length - tail.length - 4);
  const hashField = sent.subarray(head.length, sent.length - tail.length);
  if (
    sent.length !== head.length + 4 + 32 + tail.length ||
    !sameBytes(sent.subarray(0, head.length), head) ||
    !sameBytes(hashField.subarray(0, 4), u32LE(32)) ||
    !sameBytes(sent.subarray(sent.length - tail.length), tail)
  ) {
    throw new Error('The server proposed bytes that are not the change you chose, so they were not signed.');
  }
  return sent;
}

/** Propose, check, sign with this browser's key, send. Answers the act's id and the team's. */
export async function doTeamAct(organisation: string, choice: ActChoice): Promise<{ act: string; team: string }> {
  const key = await signingKey();
  const signer = getSession()?.accountId;
  if (!signer) throw new NoSigningKeyHere();
  const keyFpr = await ownKeyFingerprint();
  const request: Record<string, unknown> = {
    act: choice.act,
    as: choice.as,
    key: toHex(keyFpr),
    team: choice.team,
    subject: choice.subject,
    role: choice.role,
    scope: choice.scope ?? undefined,
    capability: choice.capability,
    undoes: choice.undoes,
    slug: choice.slug,
    name: choice.name,
  };
  const proposal = jsonObject(await signedFetch('POST', `${base(organisation)}/propose`, body(request)), 'proposal');
  const bytes = await checkedBytes(organisation, choice, proposal, signer, keyFpr);
  const signature = await signMessage(key, bytes);
  const back: Record<string, unknown> = {};
  for (const k of ['act_id', 'team', 'act', 'subject', 'subject_key_fpr', 'role', 'scope', 'capability', 'undoes', 'signer', 'signer_key_fpr', 'as', 'at', 'auth_epoch', 'root_fpr']) {
    if (proposal[k] !== null && proposal[k] !== undefined) back[k] = proposal[k];
  }
  back.signature = toHex(signature);
  if (choice.act === 'create') {
    back.slug = choice.slug;
    back.name = choice.name;
  }
  const answer = jsonObject(await signedFetch('POST', `${base(organisation)}/sign`, body(back)), 'sign');
  return { act: str(answer, 'act', 'sign'), team: str(answer, 'team', 'sign') };
}

export async function renameTeam(organisation: string, team: string, slug: string, name: string): Promise<void> {
  await signedFetch('POST', `${base(organisation)}/${encodeURIComponent(team)}/rename`, body({ slug, name }));
}

/** A slug from a name: lower case, letters and digits, single hyphens, at most 48. */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

/** The teams `account` is a member of, with what each gives them: "Through teams". */
export function throughTeams(teams: readonly Team[], account: string): { team: Team; grants: TeamGrant[] }[] {
  return teams.filter((t) => t.members.some((m) => m.account === account)).map((team) => ({ team, grants: team.grants }));
}

/** The teams `account` leads or supervises. */
export function ledBy(teams: readonly Team[], account: string): { leads: Team[]; supervises: Team[] } {
  return {
    leads: teams.filter((t) => t.leads.some((s) => s.account === account)),
    supervises: teams.filter((t) => t.supervisors.some((s) => s.account === account)),
  };
}

/** Is `account` in, leading or supervising any of `teams`? Home shows Teams only then. */
export function involvedIn(teams: readonly Team[], account: string): boolean {
  return teams.some((t) => [...t.members, ...t.leads, ...t.supervisors].some((s) => s.account === account));
}
