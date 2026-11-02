# ADR-0081: Teams, leads and supervisors

**Status:** proposed 2026-11-02. Design only; nothing is built. The owner chose the shape on
sign-off card r75-work-plan (answer "teams": *A · Teams of people with a lead, supervisors over
several teams, and a team given folder access the way a person is*). The choices inside that shape
are on card **r76-teams**, each with the recommended pick ticked; this record is written on those
picks, and changes if the owner picks otherwise.

**Builds on:** `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §3.1 (Read, Draw, Steward per folder), §3.3
(signed grants), §3.4 (verified at every use), §3.7 (groups: five constraints decided 2026-09-12),
§7 (the organisation chain). ADR-0065 (adding people at once). The Work tab (card r74, plan item 4)
and Orders and jobs (ADR-0084, plan item 7), which assign work to teams.
**Keeps:** every one of §3.7's five constraints. Stewardship stays the only power that grants
access, and it never flows through a team.

## The ask, in the owner's words (r74, 2026-11-01)

*"Some times other teams need to be tasked to do things … DIA would go through Order Management
… Design, Provisioning, and finally the installation team … Also have we even started teams? How
could we secure that, Audit etc? Because there'll be supervisors, leads, etc which will need
various levels of permissions and such for the team under them."*

## What exists, read off main (e7a788c) on 2026-11-02

- Access is per person: Read, Draw or Steward on a folder and everything under it, as a grant the
  steward's own key signs (`grants.rs`, `fathom/grant/v2`), checked at every use, with nothing
  cached. Admin is the separate operator plane and cannot grant.
- §3.7 decided groups' constraints and left the tables, signed bytes and request-time resolution
  "to design, and then to attack before building". No team, lead or supervisor exists.
- Every grant, seconding, suspension and revocation is an entry on the organisation chain, which is
  tamper-evident (HMAC chain, §7) and shown in Admin › Activity.

## Decided (on the recommended picks)

### 1. Three things, kept apart

| Thing | What it decides | Who changes it |
|---|---|---|
| **Folder access** (Read, Draw, Steward) | what a person may see and change | stewards, by signed grant |
| **Team membership** | who is in a team, and so gets the team's folder access | stewards; a team's lead (decision 4) |
| **Team roles** (lead, supervisor) | who may hand out and approve *work* | stewards |

A lead or supervisor gets **no design access of their own** from the role. Being a lead does not let
someone open a folder their team cannot open. Roles are about people and work; data access comes
only from grants. This is the line that keeps the design attackable in one sitting.

### 2. A team is §3.7's group

A team is a principal of the organisation with a name, members, at most a few leads, and
supervisors. A steward grants a team **Read or Draw** on a folder with the same signed grant a
person gets (§3.3), naming the team as subject. **A team never holds Steward** (§3.7 constraint 3).
A person's access is everything granted to them plus everything granted to each team they are in.
It is resolved at each request from the verified rows, never from a cache (§3.4).

A person may be in several teams. A team may be granted several folders.

**A team has two names that stay put and one that people read.** Its `id` is a ULID, fixed for
life; signed acts and grants name the team by it. Its `slug` (`network-design`, lower case, letters,
digits and hyphens, unique in the organisation) is chosen when the team is made and is what order
definitions (ADR-0084) write as `team: network-design`. Its display name ("Network Design") can be
renamed freely. When a steward installs an order definition, each slug is matched to a team and the
definition stores the team's `id`, so changing a slug later (a steward act, on the chain) never
breaks an installed definition; a slug with no team is shown at install for the steward to map or
create. The team's queue on the Work tab is a routed job's home until someone takes it.

### 3. Leads and supervisors

- **Lead** (of one team): assigns and reassigns the team's work, sets due dates, adds and removes
  the team's members (decision 4), approves the team's work where approval is on (decision 6).
- **Supervisor** (over one or more teams): sees every piece of work for those teams, moves work
  between them, reassigns across them, approves where approval is on, and sees each team's history.
  A supervisor is not automatically a member of the teams they supervise, so supervising gives
  no folder access.
- **Stewards appoint both**, as a signed act. A lead or supervisor must be a person enrolled with
  their own key, because they sign (§3.7 constraint 3's reason). Supervisors do not appoint leads
  in this version (card r76 option B would let them).
- **Naming.** `.context/conventions.md` reserves *supervisor* for the AI layer's orchestrator, and
  that binds identifiers. So in code, tables and chain entries the role is **`overseer`**; the
  interface says **Supervisor**, which is the owner's word. This is the only place the two differ.
- There are no departments or nested teams in this version. A supervisor is attached to the teams
  they oversee, which covers "a supervisor over Provisioning and Installation".

### 4. Who adds people to a team: the lead, from people already in the organisation

A lead may add or remove members of their own team, **choosing only from people who are already
members of the organisation** (a steward has already let them in), signed by the lead's own key.
The team's folders do not change, so a lead can widen who sees what the team sees but never what the
team sees. Stewards are told on Steward › Teams and can undo any add.

This is a narrow, written delegation of §3.7 constraint 2 ("membership is written by stewards"):
the lead's power is a steward-signed appointment, it is bounded to one team, it cannot reach a
person outside the organisation, and every use is signed and on the chain. Operators still cannot
write membership. If the owner picks r76 option B instead, the lead proposes and a steward
confirms in Waiting for you, and constraint 2 stands as written.

### 5. What is signed, and what is on the trail

- **Signed by the acting person's key**, verified at every use like a grant: creating or deleting a
  team; adding or removing a member; appointing or removing a lead or supervisor; granting or
  revoking a team's folder access; an approval. These change who may see data or who may let work
  go ahead, so they get the same proof as a grant. The signed bytes bind the fact (team id, subject
  account id, role, act, organisation, authority head), not an encoding (§3's `second_bytes`
  lesson).
- **On the organisation chain without a key signature:** assigning, taking, moving and
  reassigning work, due dates and comments. These run under the person's signed session (§4), so
  the entry already names who did it; a key touch on every reassignment would make the Work tab
  unusable on a phone.
- New chain entry types: `team_created|renamed|deleted`, `team_member_added|removed`,
  `team_role_set|cleared` (`lead`, `overseer`), `team_grant_signed|revoked`, `approval_given|refused`,
  `work_assigned|moved`. Each names the actor, the team and the person or work it touches.
- **Where people read it:** each team has a History tab (who joined, who left, who was made lead,
  what was granted, by whom, when, and whether the signature checks). Admin › Activity shows the
  same entries. A person's page in Steward › People shows "Access through teams" beside their own
  grants, so nobody's access is hidden behind a team.

### 6. Approvals: off unless a folder or an order type asks for them

A steward can mark a folder, or an order type can mark a stage (ADR-0084), as needing approval
before a plan starts or a job moves on. The approver is the assigned team's lead or a supervisor
over it. **Nobody approves their own work**: the person who drew the plan, or is assigned the job,
cannot be its approver, even when they are also the lead. Approval is signed (decision 5). With
approvals off, which is the default, nothing changes from today.

### 7. Removal, leaving, and operators

- Removing someone from a team takes effect at once (§3.7 constraint 5). Their open work for that
  team goes back to the team's queue and the lead is told.
- Removing a team's last lead leaves the team working; stewards and its supervisors see "No lead".
- Operators (Admin) see teams, members and roles and can **suspend** a membership or a role, the
  §1.1 suspend verb. They cannot add anyone to a team or appoint anyone. Suspension is on both
  chains.
- Directory sync (LDAP, later) may fill a team's membership and nothing else, marked as synced
  (§3.7 constraint 4). A synced team's lead cannot hand-edit its members.

## Where it shows (mockups on card r76-teams)

- **Steward › Teams:** a list of teams with lead, supervisors, member count, folders and open work.
  **New team** asks a name, then members, then which folders at Read or Draw.
- **Home › Teams:** a tab beside Designs for anyone who is in, leads or supervises a team, listing
  those teams.
- **A team's page:** Members (with a Lead badge), Supervisors, Folders, Work (its queue on the Work
  tab), History. A lead sees Add member and Remove; others in the team see the page read-only.
- **Steward › People › a person:** their own grants, then "Access through teams", then "Leads" and
  "Supervises".
- **Work tab:** "Mine", "My team's" and, for a supervisor, "My teams'" filters; Assign offers the
  team's members.

## Still to do before building (from §3.7)

1. The `teams`, `team_members` and `team_roles` tables with composite foreign keys onto
   `principals`, and a migration number claimed from the coordinator.
2. The signed byte constructions for each act in decision 5, with golden vectors beside
   `tests/authority_vectors.rs`.
3. Request-time resolution of a team grant without a second cache to poison (§3.4).
4. **An attack round on 1 to 3 before any schema is touched**, as §3.7 requires, with the lead's
   membership power (decision 4) as its first target.

## What it gives up, named

- **Custom roles** (r75 option B, permission by permission) are not in this version. The three
  roles are fixed. Custom roles could come later on top, if a real case needs one.
- **A lead can widen who sees a folder** by adding an organisation member to their team. That is
  the point of decision 4. It is bounded and signed, and the steward is told. Option B on r76
  closes it, at the cost of a steward's press for every team change.
- **Assignments are not key-signed.** The trail says who moved work, under their session; it is not
  a hardware-touched proof. Moving work grants no access, so this is the right weight.
