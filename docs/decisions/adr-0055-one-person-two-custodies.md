# ADR-0055 — One person, two custodies: the address is the identity, and two operators is the standing shape

**Status:** proposed 2026-09-21, waiting on the owner. Nothing here is built.
**Reopens, on merit:** admin design §4.5 point 3 as built (an operator has no address of record),
§5.3's `FATHOM_SINGLE_OPERATOR` switch, and §6.3's refusal to re-key an operator from the host once
any key exists.
**Keeps:** §0's two custodies and the composite foreign keys under them, §4.5's rule that the admin
surface never rests on a factor the server can re-issue, ADR-0043's key file, the delay and the
seal on every operator act.

## The owner's words, 2026-09-21

*"My goal is my account will be admin, or whoever has that email in .env … you could have in the
logs that smtp should be setup via inside the operator mode to prevent lockout. There's also the
fact we may need more than one operator, and a handoff solution if a change of hands occurs. It
should probably be best practice to have 2 anyways, if one of them becomes disposed then otherwise
the entire org would be locked out."* And earlier the same day: *"Wait but I'll be on multiple
computers?"*

## What is built now, and where it locks the owner out

Read off the code on 2026-09-21 (`crates/fathom-server/src/operators.rs`, `config.rs`, `main.rs`).

1. An operator is a principal with no address. They sign in with a 26-character id handed to them
   once at enrolment. Their account, if they have one, is a different principal with its own key.
2. The first operator's only way in is the token file the first start writes. `reissue-bootstrap-token`
   refuses the moment any operator key has ever been enrolled. A sole operator who loses their
   browser is locked out with no path back but a restore.
3. An operator holds one usable key: sign-in takes the newest live one, and no route mints a token
   for an operator who already exists. One browser per operator, and no way to add a second computer.
4. Adding an operator needs two signatures unless `FATHOM_SINGLE_OPERATOR=true`. The switch is off
   by default and is not in `compose.yaml` or `.env.example`. **A fresh install's sole operator
   therefore cannot add a second operator at all.** The design solved the same deadlock for
   stewards (§3.5, `min(2, live stewards)`) and never ported the fix to operators.
5. Handoff exists in pieces: an operator can disable another (§1.1), but nobody can be added first.
6. No mail path exists, so no notice and no recovery by mail; the log says nothing about it.

## What others do

Read 2026-09-21 by two research passes. The session's egress policy blocked the vendors' doc sites
and every NIST, OWASP, CIS, Microsoft and AWS host, so the sources are the publishers' own GitHub
repositories (marked **D**, read directly) or a search engine's extract of the official page
(marked **S**, one step weaker). Re-verify an **S** row before quoting it anywhere user-facing.

| Product | First admin | Bootstrap credential | Admin is | Two admins / recovery |
|---|---|---|---|---|
| Keycloak | `KC_BOOTSTRAP_ADMIN_*` env, **first start only**; later `kc.sh bootstrap-admin` (S, keycloak.org/server/bootstrap-admin-recovery) | **temporary, said in the product**: banner, labels, "needs to be removed manually" | role on a user | host command re-creates a temporary admin |
| Authentik | `AUTHENTIK_BOOTSTRAP_*` env, read on first start only (S, docs.goauthentik.io/install-config/automated-install) | not temporary | group on a user | — |
| Nextcloud | `NEXTCLOUD_ADMIN_USER/_PASSWORD`, install time only (D, nextcloud/docker README) | not temporary | group on a user | — |
| GitLab | password in `/etc/gitlab/initial_root_password`, **deleted after 24 h** (D, gitlabhq `doc/install/package/ubuntu.md`) | time-boxed file | flag on `root` | `gitlab-rake "gitlab:password:reset[root]"` on the host |
| Portainer | first visitor, but a **setup token printed to the log** and a **5-minute window**, then the server stops listening until restarted (S, docs.portainer.io/faqs/installing/setup-token) | one-shot | role on a user | offline helper container resets or creates an admin |
| Grafana | ships a default server admin (D, grafana `roles-and-permissions/_index.md`) | not temporary | **two planes**: "the server administrator role is distinct from the organization administrator role"; one user may hold both | `grafana cli admin reset-admin-password` on the host |
| NetBox | `manage.py createsuperuser` on the host; the docker image's `SUPERUSER_*` env is "if you need to restart NetBox from an empty database often" (D, netbox-docker README) | the real account | Django superuser flag | the same command |
| HashiCorp Vault | `operator init` yields an initial root token; "you should revoke the initial root token" (S, developer.hashicorp.com production-hardening) | temporary, strongly | a token, not a user | `generate-root` re-mints one from a **quorum of key holders**; nothing standing |
| Vaultwarden | `ADMIN_TOKEN`, a standing shared secret with no identity (D, vaultwarden wiki Enabling-admin-page) | standing | not a user | the wiki gives **no** advice to block `/admin` at the proxy; only "activate HTTPS first" |

**Two admins.** GitHub, verbatim (D, github/docs `org-ownership-recommendation.md`): *"If an
organization only has one owner, the organization's projects can become inaccessible if the owner
is unreachable. To ensure that no one will lose access to a project, we recommend that at least two
people within each organization have the owner role."* Microsoft Entra (D, entra-docs
`security-emergency-access.md`, page dated 2026-06-04): *"two or more emergency access accounts"*,
excluded from the policies that could lock them out, credentials in physical custody, *"alerts for
every use"*, validated at least every 90 days. No product's own docs said "keep two"; the advice
lives with the organisations.

**The credential.** NIST SP 800-63B revision 4 is final (D, usnistgov/800-63-4 README; the date,
July 2025, is from a search extract). It accepts syncable passkeys at AAL2 and refuses them at AAL3
(Appendix B). It says a code that binds a new device *"SHALL NOT be communicated over any insecure
channel (e.g., email)"*, is single use and lives at most 10 minutes (§4.1.2.2), while a recovery code
**may** go by mail, once, for at most 24 hours (§4.2.1.2). OWASP ASVS 5.0.0 (released 2025-05-30)
6.3.6 forbids email as a factor at level 3, and 8.4.2 says network location may reduce risk for an
administrative interface and *"[is] not the sole factor for authorization"*. Passwords, where all
three sources allow them, are the weakest option they list: 15 characters standalone, 8 with a
second factor, no composition rules, a breach blocklist (800-63B-4 §3.1.1.2; ASVS 6.2).

**What this says for Fathom, in one breath.** Seed the first admin from the environment on the
first start only, and say in the product that the seed is spent. Make admin a custody a person
holds, not a separate person. Recover from the host, because every product does and ADR-0043
already gives the host every key; make it loud instead of silent. Add devices from a signed-in
device with a short code on the screen, never by mail; recover by mail only. Keep two.

## Decision, proposed

1. **The address is the identity; the custodies stay two underneath.** The first start creates an
   account for `FATHOM_OPERATOR_NOTICE_ADDRESS` and an operator bound to it (`operators.account_id`,
   migration 0016). One token enrols one key into both `account_keys` and `operator_keys`. A person
   signs in with their address; the client signs both challenges with the same key and holds two
   sessions; Home shows the Site console to anyone whose account holds the operator custody. The
   composite foreign keys are untouched: an operator principal still cannot appear in a membership
   or a grant. Grafana's shape, with the database's own fences under it.
2. **The environment seeds; the register rules.** The address in `.env` is read on the first start
   and never again, as Keycloak, Authentik and Nextcloud do. A later change to it logs one line
   naming the register as the truth and does nothing. Handoff happens in the console, not in a file.
3. **Operator quorum is `min(2, live independent operators)`**, §3.5's rule ported: a sole operator
   adds a second alone, with the 24-hour delay, a banner in every operator session, a cancel button,
   and notice by mail once mail exists. `FATHOM_SINGLE_OPERATOR` is retired; the sealed
   `single_operator_mode` entry becomes a derived fact written whenever the live count is one.
   Quorum 1 with no delay is still not offered.
4. **Two operators is the standing expectation.** With one live operator the server warns at every
   start and the console shows a standing banner that escalates weekly, as §8.3 does for a sole
   steward. It never blocks work.
5. **Handoff** is: add the successor (3), they enrol and sign in on their own, then either disables
   the predecessor (§1.1) or the predecessor retires themself. `site_install.notice_address` stays the
   install-time record §6.2 pins claims to; notices go to every live operator's address.
6. **A second computer is added from a signed-in browser**: a code shown on the screen, at least
   112 bits, single use, ten minutes, redeemed on the other computer, enrolling a key into both
   custodies. Never mailed. Sign-in accepts any live key of the person (`live_operator_key`'s
   `LIMIT 1` goes). An operator's keys are listed and retirable in the console.
7. **Recovery by mail restores the account custody only.** Once SMTP is applied (§5.3), a recovery
   code goes to the address of record, once, for 24 hours, with one answer and one timing for
   every address (ASVS 6.3.8). It enrols a fresh key for the *account*; the *operator* custody is
   re-bound only by another operator through (3), or by (8). §4.5 holds: nothing the server can
   re-issue opens the admin surface. Until SMTP is applied, every start logs: *"recovery by mail is
   unavailable until SMTP is set in the console; until then the only recovery is
   `fathom-server recover-operator`"*.
8. **Break-glass is a host command, loud.** `fathom-server recover-operator <address>` runs where
   the key volume is mounted, re-keys an operator who already exists, prints a one-shot ten-minute
   code to the terminal, and refuses to mint a new operator. Every use appends a sealed
   `operator_recovered_from_host` entry, notifies every operator, and banners every operator session
   for seven days. No delay: the host already holds every key (ADR-0043 §2), so a delay here is
   theatre, and Entra's model is the same, custody plus alerting rather than a weaker front door.
   `reissue-bootstrap-token` folds into it: before any key exists it re-mints the bootstrap, after
   that it re-keys. The drill is written into `docs/OPERATING.md` and rehearsed on the 90-day cadence
   Entra names.
9. **The admin surface stays where it is.** In-app confinement by host and source (PR #26) is the
   gate; an allowlist at the reverse proxy is defence in depth the runbook recommends and never the
   only control (ASVS 8.4.2). Nothing to build.
10. **The credential stays the browser key; passkeys are next; passwords stay out.** The key is a
    software cryptographic authenticator, single-factor possession today. WebAuthn (NEXT.md item 4)
    makes it a passkey, which 800-63B-4 accepts at AAL2 with sync. A password would be the weakest
    credential every source lists and would reopen §4.5 for the admin surface. The owner may
    overrule; the cost is one new crate against the ceiling and a re-issuable factor on `/admin`.

## What it gives up

- An operator now has an address, for notices and as their sign-in name. §4.5 point 3 as built said
  they had none; the reason was that §4.5 gives operators no address *to reset*, and (7) keeps that.
- The explicit `FATHOM_SINGLE_OPERATOR` declaration becomes a derived, sealed fact. Nobody can
  claim two-person control was in force when the chain says the count was one.
- §6.3's "never from the host once a key exists" becomes "from the host, recorded and noticed".
  What it protected against, a quiet backdoor for anyone with a shell, was already inside tier 3.

## Cost and order

Three sessions, one migration, no new crate.

1. **Server.** Migration 0016 (`operators.account_id`, a `person` token purpose, the recovery entry
   type). First start creates account plus operator. One challenge, two sessions. Any live key.
   Quorum `min(2, live)` with the delay and the derived single-operator fact. Startup warnings for one
   operator and for no SMTP. `recover-operator`. The refusal tests move with the rules: adding a
   second operator alone is refused at once and applied after the delay; a host recovery cannot
   mint; a mailed code never touches `operator_keys`.
2. **Client.** Sign-in by address only, the console reached from Home, "Add a computer" with the
   on-screen code, the operators page with add, disable and the one-operator banner, the keys list.
3. **Docs.** RUNNING-IT §5, OPERATING's break-glass drill, STATE, `.env.example`.
4. **After SMTP lands:** recovery by mail (7) and mailed notices for (3), (5) and (8).

## Questions for the owner

Recorded as `docs/OPEN-QUESTIONS.md` C6: the 24-hour wait on the very first colleague, the
no-delay host recovery, and passwords staying out.
