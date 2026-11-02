# Teams: the attack round on paper (ADR-0081, 2026-11-02)

ADR-0081 ("Still to do before building") and admin design §3.7 require the tables, the signed bytes
and request-time resolution to be attacked before any schema is touched. This is that round. It
read `migrations/0004_principals.sql`, `0011_authority.sql`, `src/grants.rs` (the §3.4 walk,
`verify_grant_row`, the seconding qualification) and `src/authority.rs` on main at d8f246d.
Each finding ends in a decision the build carries out. Attackers are §0.1's tiers.

## What is attacked

As first drafted: a team is a principal; a steward grants it Read or Draw; stewards and the
team's lead add members; stewards appoint leads and supervisors (`overseer` in code). A person's
access is their own grants plus their teams' grants, resolved at each request.

## Findings

**T1. A subtree steward reaches the whole organisation through a team.** Teams are
organisation-wide, and a membership widens every grant the team holds, at every scope. If any
steward could add members or appoint leads, a steward of one site adds themselves to a team
holding Draw at the root and gains Draw on everything. *Decided:* creating, deleting and staffing
a team (members, leads, supervisors) is a power of a steward **at the organisation's root**. A
steward of a subtree may grant or revoke a team's access only at a scope they steward, exactly as
for a person. Both are checked at use, not only when proposed.

**T2. A lead adds themselves.** The ADR promises the lead role gives no folder access. A lead who
is not a member could add themselves and get it. *Decided:* a lead may not add or remove
themselves. This is a table `CHECK`, so a row of that shape cannot be stored, and it is refused
when the act is proposed. A root steward may still put a lead in their own team. *Residual,
admitted:* a lead can add a colluding organisation member. That is decision 4's delegation; it is
signed, on the chain, shown to stewards, and bounded to people a steward already let in.

**T3. What a demoted lead's adds are worth.** If a membership counted only while its signer is
still a lead, removing a lead would silently drop everyone they added. If it never re-checked
the signer, a forged "lead" could add people. *Decided:* as §3.5 does for secondings, a member
row counts only if its signer held the authority it claims (root steward, or this team's lead
and not suspended) **at the row's chain position**. A lead removed later still added; someone
who was never lead never did. "Remove lead" on the screen offers to remove the people they added.

**T4. A cycle through teams into stewardship.** If a team grant could ever satisfy a steward
check, a lead could add someone who then appoints leads. *Decided:* team grants live in their own
table, `team_grants`, whose capability `CHECK` admits only `read` and `draw`. The steward walk
(`steward_held_at`, quorum, sole-steward count) reads `scope_grants` only and never team rows,
so no team row is an input to any steward answer. `scope_grants.subject_kind` stays generated
as `'steward'`, so a team id can never be the subject of a scope grant.

**T5. One signature, two meanings.** Signing a team grant with `fathom/grant/v2` bytes and the
team id as subject would make a team grant and a person grant the same shape. Ids are unique
across principals, so nothing collides today, but domain separation costs nothing. *Decided:*
every team act is signed over its own construction, `fathom/team/act/v1`, which binds the act
by name. A signature over one act never verifies as another, or as a grant.

**T6. The key-swap replay §3.3 closes for grants.** An attacker who swaps a member's public key
for one they hold could sign in as the member and inherit the team's access. That attack takes the
whole account, direct grants included, and is closed where it starts: the keyring is sealed.
*Decided:* for parity, the member row binds the member's key fingerprint when they have one,
checked at use as `verify_grant_row` checks `subject_key_fpr`. Someone added before enrolling a
key is bound by account alone, as ADR-0065 grants are. Leads and supervisors must have a key,
because they sign.

**T7. Deleting the row that removed someone.** A tier-2 attacker deletes a "removed" row to
reinstate a member, or edits a grant row's capability. *Decided:* team acts are **append-only
rows** in one table, `team_acts`: removals, revocations and role clearances are new signed rows
naming the row they undo, never deletes or updates. Every act advances the authority head and is
in its `live_digest` and stored-seal check, beside grants. A deleted, added or edited row makes
the whole organisation `Unverifiable` at its next use, the same posture as a grant.

**T8. An operator staffs a team.** §3.7 constraint 2. *Decided:* no operator route writes a team
act; the signer column is a `steward`-kind principal by composite foreign key, as for grants.
Operators may **suspend** a membership or a role (§1.1's verb), a separate append-only row, which
only ever removes access. Suspending every lead is denial of service, which §1.1 already admits.

**T9. A second cache to poison (§3.4).** *Decided:* team rows are read in the same
`read_authority_state` pass, digested by the same head, in the same transaction, and a person's
teams are worked out inside each authorisation call and thrown away with it. Nothing about teams
is stored per session or per account.

**T10. Replaying an old add after a removal.** *Decided:* every act binds the organisation, its
root fingerprint, the team id, the authority epoch it was proposed at, and a fresh act id. The
server re-derives the epoch and refuses a stale one, as `sign_grant` does, so an old signature
cannot be stored again. A removal names the row it undoes by id and by `H(act_bytes)`.

**T11. A deleted team, or a reused name.** *Decided:* deleting a team is a signed act; its grants
and memberships stop counting at once. The team's id is a ULID and its principal row is never
deleted (no `DELETE` policy on `principals`), so the id is never reused. The slug may be reused
after deletion; nothing signed names a slug.

**T12. The supervisor role as a back door.** *Decided:* resolution never reads `lead` or
`overseer` rows for folder access. A test proves a supervisor of a team with Draw cannot open the
folder, and gains it only by being added as a member.

**T13. Leaving the organisation.** A person removed from the organisation keeps their team rows,
but cannot open the organisation's context, so they reach nothing. A lead may add only someone
who is a member of the organisation when the act is proposed.

## Not attacked here, because not built yet

Approvals (decision 6) wait for the Work tab and orders. Work assignment entries are chain entries
under a session (decision 5) and grant no access. Directory sync, departments and custom roles each
get their own round (ADR-0081, "Later").

## The tables that follow

`teams` (id, organisation, slug, display name, its creating act), `team_acts` (append-only, one
row per signed act: `create`, `delete`, `member_add`, `member_remove`, `role_set`, `role_clear`,
`grant`, `grant_revoke`), and `team_suspensions` (operator, append-only). ADR-0081 said three tables
(teams, members, roles); T7 is why members and roles are acts in one log instead.
