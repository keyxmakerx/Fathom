# ADR-0080: Termix in the work — plans, logins by reference, snippets and checks

**Status:** proposed 2026-11-01. The choices are on sign-off card r72-termix-work with a
recommended pick ticked on each. Nothing here is built. Where the owner picks differently, this
record follows the card.

**Builds on:** ADR-0078 (Termix beside Fathom, accepted and built), ADR-0071 part four (outside
vaults), the maintenance plans of `docs/STATE.md` (#98: Plan, Do, Record).
**Keeps:** invariant 2 under every recommended pick, rule 4 and ADR-0042, and ADR-0078's shape: the
browser talks to Termix with the person's own key, and Fathom's server never calls Termix.

## What the owner asked for

> Then they go into maintenance where there is some interaction with optional troubleshooting, and
> then there can be checks maybe for some stuff? [...] Integration with termix will be a big one

ADR-0078 gets a person from a device to its terminal. This record is about the rest of the work:
the plan names devices, steps and commands, Do walks through them, and Record keeps what happened.
Termix is where the person types. The question is how much of the plan reaches Termix, and how
much of what happened in Termix comes back.

## Where part one stands

Built: Open in Termix, Add it to Termix, Send N to Termix, the steward's and the operator's
switches (`src/termix.rs`, `client/src/components/termix/`). **Not tried against a running Termix**
(`docs/STATE.md`): the tests use Termix's request and reply shapes read from its code. Everything
below leans on part one, so the first recommendation is to prove it.

## What Termix offers now

Read from Termix's source on 1 November 2026, not from memory (CLAUDE.md rule 1): core at commit
`c759a14` (30 October 2026, version 26.10.6), and the bundled plugins named below at their heads
that day. "Bundled" means listed in `docker/bundled-plugins.json`; an operator may still turn any of
them off, so every feature below that is a plugin's must work when the plugin is missing.

| Fact | Where |
|---|---|
| A host's password and key fields may hold a reference, `<scheme>://...`, instead of a secret. Termix resolves it each time it connects, through whichever plugin registered the scheme, and caches the value for 60 seconds. Core registers no scheme. User name is not one of the fields. | core `src/backend/hosts/external-secrets.ts` (`SECRET_FIELDS`), `src/backend/hosts/connect/secret-resolver-registry.ts` |
| The Secret Sources plugin (1.1.0) registers `op`, `infisical`, `bws`, `vault` and `bw`. `bw://<item name or id>/<field>` reads a Bitwarden or Vaultwarden vault through the Bitwarden CLI's `bw serve`, which the Termix operator runs and unlocks. | `Termix-SSH/Plugin-Secret-Sources` `8088014`, `manifest.json` (`contributes.auth.secretSchemes`), `src/backend/providers/bitwarden-cli.ts` |
| The Snippets plugin (1.2.0) keeps commands in folders, with variables for the host and the person's own inputs, shared to users or roles. `POST /plugin-api/snippets` makes one (`name`, `content`, `folder`). `POST /plugin-api/snippets/execute` runs one on a host and answers with its output. | `Termix-SSH/Plugin-Snippets` `d66ae50`, `src/backend/routes.ts` |
| The Automations plugin (1.2.0) has maintenance windows: `POST /plugin-api/automations/maintenance/{hostId}` with `action` `start`, `schedule`, `end` or `remove`, a `reason` and `durationMinutes`. While a host is in maintenance, automations triggered by its status, health checks, metrics, Docker or tunnels do not fire. Only the host's owner may change it. | `Termix-SSH/Plugin-Automations` `4468c55`, `src/backend/maintenance-routes.ts` |
| `GET /host/status?hostIds=...` answers each listed host's up or down, for hosts the caller may see. | core `src/backend/database/routes/host-status-routes.ts` |
| Plugin routes sit behind core's own sign-in, which takes an API key as `Authorization: Bearer`. An API key is refused only where it would impersonate another user. | core `src/backend/plugins/http.ts` (`authenticate`), `src/backend/utils/auth-manager.ts` |
| `POST /users/ws-ticket/api-key` gives an API key a one-minute ticket that opens plugin WebSockets, the terminal's included, as the key's user. | core `src/backend/database/routes/user-socket-ticket-routes.ts` |
| Session Recording (1.1.0) records SSH, RDP and VNC sessions for playback and download. Serial (1.0.2) opens a console over Web Serial in Chrome, Edge or Firefox 151 and newer. | `Termix-SSH/Plugin-Session-Recording` `2602f91`, `Termix-SSH/Plugin-Serial` `1260614`, their READMEs |

Read from code, not tried. A plugin route reached with an API key from another origin is the part
most likely to surprise; the first piece of work (decision 1) settles it.

## Proposed (the recommended picks on r72-termix-work)

1. **Prove part one against a real Termix first** ("Also build", ticked). A CI job starts Termix
   26.10.6 from its published image beside Fathom, makes a user and an API key, and a drive script
   (`scripts/drive-termix.mjs`, in the style of `drive-backout.mjs`) runs Open in Termix, Add it to
   Termix and Send N to Termix through a real browser. Nothing else here starts until it passes.

2. **Where the terminal opens: a new tab, from the step** (question 1, A). In Do, a step that names
   a device shows **Open in Termix** beside it, the same lookup as part one. The plan's own panel
   lists its devices once, each with its Termix button, so a person can open them all before the
   window starts. No `frame-src`, no terminal inside Fathom.

3. **Logins go by reference, never by value** (question 2, A). A device whose login was pulled from
   an outside vault (ADR-0071 part four) is added to Termix with its password field set to a
   reference: `bw://<Vaultwarden item id>/password`, and the matching scheme for Delinea or
   Passbolt once Termix has one. The reference names an item; it is not the secret, and Fathom
   already shows item names to the people who may use them. Termix fetches the password itself, in
   its own `bw serve`, at connect time, and only if the Termix operator connected Secret Sources to
   a vault that can see that item. Fathom never reads the password to do this. A login held only in
   Fathom's own vault (modes A and B) still never goes to Termix: there is no scheme for it, and
   making one would mean Fathom's server handing a secret to another server. User name stays as
   ADR-0078 left it: the person sets it in Termix.

4. **Step commands become Termix snippets; the person runs them** (question 3, A). Where a step
   carries commands (the firmware upgrade plans for Junos, IOS XE, NX-OS and EOS, and their From Windows and From
   Linux steps, do today), **Send to
   Termix** makes one snippet per step in the folder `Fathom / <plan name>`, named
   `<step number> · <step title>`, with the device's host name as a variable. The person runs it in
   Termix, on the terminal they opened. Fathom never calls `/execute`. Plan text is already gated
   like notes (`docs/STATE.md`, maintenance plans), so a snippet carries nothing a note could not.

5. **Checks: the person pastes what they saw** (question 4, A). A check step gets a box: paste the
   output of the command the step names. The redaction gate runs on it in the browser exactly as on
   any paste (rule 4). Fathom compares what it can (a version string, an interface up, a neighbour
   seen) and says Matches, Differs or Can't tell; the person still marks Done or Went differently.
   What is kept on Record is the redacted paste.

6. **Start work opens a Termix maintenance window** ("Also build", ticked). If the Automations
   plugin answers, Start work in Do puts each of the plan's devices that Termix has into maintenance
   with the plan's name as the reason and its estimated time as the duration, and Record ends it.
   A host the person does not own in Termix is skipped and counted. If the plugin is off, nothing is
   said beyond one line.

7. **Termix's up or down beside the plan's devices** ("Also build", ticked). Do shows each device's
   status from `GET /host/status`, read when Do opens and when the person presses Refresh, never on
   a timer. It is Termix's opinion, labelled as Termix's.

## The other options, and why not now

- **Question 1, B, Termix framed beside the plan.** Needs `frame-src` opened to the Termix origin
  and Termix's sign-in cookie to work inside a frame on another site, which browsers increasingly
  refuse. Untried; revisit after decision 1.
- **Question 1, C, Fathom's own terminal pane** over Termix's WebSocket with an API-key ticket. Would
  add a terminal library to the client (the dependency gates) and tie Fathom to a socket protocol
  that belongs to a Termix plugin and can change. The biggest build here, for a tab's worth of gain.
- **Question 2, B, nothing (as now)** keeps ADR-0078 exactly. Fair if Termix's operator will not run
  Secret Sources.
- **Question 2, C, copy the password into Termix.** ADR-0042 allows a stored credential to leave only
  shown and chosen; this would put a copy where Fathom can no longer remove it, and a rotated
  password goes stale in Termix. Not recommended.
- **Question 3, B, a Copy button only.** The smallest change; no snippets in Termix.
- **Question 3, C, Fathom runs the step through `/execute` and reads the output back.** This is
  Fathom driving a device, through Termix. It breaks invariant 2 as written ("No SSH, no NETCONF,
  no API. All output is copy-paste"), so it needs the owner to amend the invariant first
  (`.context/conventions.md` notes the owner's long-term intent and that only the owner closes that
  gap). The output would also be a config-shaped answer arriving without a paste, so it must pass
  the redaction gate in the browser before anything is kept, the same as a paste.
- **Question 4, C, Fathom fetches the check's output.** Only with 3 C, for the same reasons.

## Why invariant 2 still holds (recommended picks)

Fathom opens no connection to a device. The browser tells Termix things (a host, a reference, a
snippet, a maintenance window) and asks it things (which host, up or down). Termix connects, in a
tab the person opened, as the Termix user the key belongs to, when the person presses its buttons.
Output reaches Fathom only by the person's paste.

## What this does not protect against

- A Termix whose Secret Sources can see more of the vault than the Fathom connection can. The
  reference names one item; what Termix's `bw serve` can open is the Termix operator's to limit.
  The page says so where the reference is sent.
- Everything ADR-0078 lists: the key in `sessionStorage`, and an operator who names the wrong Termix.
- A snippet edited in Termix after Fathom sent it. Fathom does not read snippets back; the plan is
  the record of what was meant, and the paste in a check is the record of what was seen.

## Not decided here

- A link from a step's Record to a Termix session recording ("Also build", left unticked).
- Opening a console port's serial console through Termix's Serial plugin (unticked).
- An "In Termix" column in Inventory (unticked again, as on r43-termix).
- Termix's own Network Topology plugin draws hosts and links; importing Fathom's graph into it is
  not proposed.
