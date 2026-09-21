# ADR-0055 — One person, two custodies: the address is the identity, a password opens it, and two operators is the standing shape

**Status:** accepted 2026-09-21 on the owner's "sounds good, please proceed", after two rounds of
amendment the same day. Building starts from this text.
**Reopens, on the owner's decision:** admin design §4.5 (the operator surface had no password
path; it now has one, guarded as decision 10 says), §4.5 point 3 as built (an operator has no
address of record), §5.3's `FATHOM_SINGLE_OPERATOR` switch, and §6.3's refusal to recover an
operator from the host once any credential exists.
**Keeps:** §0's two custodies and the composite foreign keys under them, §4.2's per-request proof
by a browser-held session key, ADR-0043's key file, the delay and the seal on every operator act.

## The owner's words, 2026-09-21

*"My goal is my account will be admin, or whoever has that email in .env … you could have in the
logs that smtp should be setup via inside the operator mode to prevent lockout. There's also the
fact we may need more than one operator, and a handoff solution if a change of hands occurs. It
should probably be best practice to have 2 anyways."* Then: *"I really would prefer a password
reset though … I want high security."* Then: *"if we could have a setting that says only /admin
can login via a different URL, that the buttons associated with operator is completely gone
unless on that URL. So it's both blocked by reverse proxy and the app."* And last: *"I'd prefer
if the admin URL and the smtp settings were setup via the operator menu. Just be sure there is
adequate warning … and a redirect. Maybe even a 5 min timer (maybe variable timer but can not be
turned off) and if operator hasn't logged in, then the admin URL is disabled back for being
generic."*

## What is built now, and where it locks the owner out

Read off the code on 2026-09-21 (`crates/fathom-server/src/operators.rs`, `config.rs`, `main.rs`,
`admin_exposure.rs`, `sessions.rs`).

1. An operator is a principal with no address. They sign in with a 26-character id handed to them
   once at enrolment, by signing a challenge with a key their browser holds. Their account, if
   they have one, is a different principal with its own key.
2. The first operator's only way in is the token file the first start writes. `reissue-bootstrap-token`
   refuses the moment any operator key has ever been enrolled. A sole operator who loses their
   browser is locked out with no path back but a restore.
3. An operator holds one usable key: sign-in takes the newest live one, and no route mints a token
   for an operator who already exists. One browser per operator.
4. Adding an operator needs two signatures unless `FATHOM_SINGLE_OPERATOR=true`. The switch is off
   by default and is not in `compose.yaml` or `.env.example`. **A fresh install's sole operator
   therefore cannot add a second operator at all.** The design solved the same deadlock for
   stewards (§3.5, `min(2, live stewards)`) and never ported the fix to operators.
5. The console can be confined to a host and to source addresses (`FATHOM_ADMIN_HOSTS`,
   `FATHOM_ADMIN_SOURCES`, since 2026-09-20, in the binary, 404 elsewhere). The client does not
   know: it still shows the console and fails. SMTP is a designed setting (§5.3) with no form.
6. No mail path exists, so no notice and no recovery by mail; the log says nothing about it. The
   server sends no content security policy and no HSTS (OPEN-QUESTIONS C5).

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
July 2025, is from a search extract). Passwords used alone must be at least 15 characters, with a
second factor at least 8, at most 64 or more, no composition rules, no periodic change, checked
against a blocklist of known-compromised values (§3.1.1.2). *"Email SHALL NOT be used for
out-of-band authentication"* (§3.1.1.2), and OWASP ASVS 5.0.0 (released 2025-05-30) 6.3.6 forbids
email as a factor at level 3. A recovery code **may** go by mail, once, for at most 24 hours
(§4.2.1.2). Verifiers *"SHALL offer at least one phishing-resistant authentication option at
AAL2"*, which a TOTP app is not and a passkey is; syncable passkeys are accepted at AAL2 (Appendix
B). ASVS 6.4.3: a reset *"does not bypass any enabled multi-factor authentication mechanisms"*;
6.3.8: no account enumeration through messages, codes or timing; 8.4.2: network location may
reduce risk for an administrative interface and is *"not the sole factor for authorization"*. The
OWASP Forgot Password Cheat Sheet: tokens random, single use, expiring, the same answer for every
address, sessions invalidated, no automatic sign-in.

**What this says for Fathom, in one breath.** Seed the first admin from the environment on the
first start only, and say in the product that the seed is spent. Make admin a custody a person
holds, not a separate person. A password is fine when a second factor the server cannot mail
stands beside it and a mailed reset never restores the admin seat by itself. Recover from the
host, because every product does and ADR-0043 already gives the host every key; make it loud
instead of silent. Keep two.

## Decision

1. **The address is the identity; the custodies stay two underneath.** The first start creates an
   account for `FATHOM_OPERATOR_NOTICE_ADDRESS` and an operator bound to it (`operators.account_id`,
   migration 0016). A person signs in with their address; the session carries both principals when
   the account holds the operator custody; Home shows the Site console to them. The composite
   foreign keys are untouched: an operator principal still cannot appear in a membership or a
   grant. Grafana's shape, with the database's own fences under it.
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
5. **Handoff** is: add the successor (3), they sign in on their own, then either disables the
   predecessor (§1.1) or the predecessor retires themself. `site_install.notice_address` stays the
   install-time record §6.2 pins claims to; notices go to every live operator's address.
6. **Any browser, no pairing.** Sign-in is the address, the password and the app code. No key is
   copied and no device is paired. The browser generates a fresh session keypair at every sign-in
   and every request is signed with it, exactly as §4.2 has it today; what changes is how the
   session is obtained, not how it is proven afterwards.
7. **Reset by mail, for the password only.** Once SMTP is applied (11), "forgot my password" sends a
   one-time link to the address of record: at least 128 bits, single use, 24 hours, the same
   answer and timing for every address, per-account and per-source rate limits that already exist.
   It sets a new password. It never skips the app code. On an account that holds the operator
   custody it does not restore that custody by itself: the seat waits for another operator's
   confirmation or the 24-hour delay with notice to every operator, so a colleague who controls the
   mail server cannot reset their way into a second seat. Every other session of the account ends.
   Until SMTP is applied, every start logs: *"recovery by mail is unavailable until SMTP is set in
   the console; until then the only recovery is `fathom-server recover-operator`"*.
8. **Break-glass is a host command, loud.** `fathom-server recover-operator <address>` runs where
   the key volume is mounted, for an operator who already exists, and prints a one-shot ten-minute
   setup code that lets that person set a new password and enrol a new app code. It dispossesses
   the seat's current holder as it does so: operator keys retired, both principals' sessions
   ended, the app code, its backup codes and any seat hold cleared. It refuses to mint
   a new operator. Every use appends a sealed `operator_recovered_from_host` entry, notifies every
   operator, and banners every operator session for seven days. No delay: the host already holds
   every key (ADR-0043 §2), so a delay here is theatre, and Entra's model is the same, custody plus
   alerting rather than a weaker front door. `reissue-bootstrap-token` folds into it. The drill is
   written into `docs/OPERATING.md` and rehearsed on the 90-day cadence Entra names.
9. **The console lives on its own host, and the client knows it.** The server half exists
   (`admin_exposure.rs`). The client half is new: the server tells the client whether the host it
   was served on is a console host, and on any other host the console entry and every operator
   control are absent, not hidden. **As built (2026-09-21), precisely:** the operator custody is
   exercised only through `/admin`, which the placement confines, and an operator key can be
   registered only there, so off a console host there is nothing an operator session could do;
   the sign-in route itself is not confined by host, and the client shows no operator door there.
   An allowlist at the reverse proxy for the console host is defence in depth the runbook
   recommends and never the only gate (ASVS 8.4.2): sign-in with a second factor stands under it.
10. **The credential is a password and an app code; email is never a factor.**
    - Password: argon2id (parameters from the OWASP Password Storage Cheat Sheet, looked up at
      build time, not assumed); at least 15 characters and at most 128; no composition rules; no
      expiry; refused when it is on a bundled list of common passwords or contains the address;
      the online breach check is an option for a server with egress and off otherwise, because
      Fathom may run air-gapped.
    - App code: RFC 6238 TOTP, SHA-1, six digits, 30-second step, one step of skew, the secret
      sealed under the ring key and never shown again after enrolment, a code accepted once.
      **Required for any account holding the operator custody**: such an account is taken to the
      enrolment screen before anything else until it has one. Ten single-use backup codes, hashed,
      shown once at enrolment, for the lost phone.
    - The phishing-resistant option NIST requires the verifier to offer is a passkey or security
      key as the second factor, in the WebAuthn step NEXT.md item 4 already holds. It is not in
      this build; the app code is.
    - The first operator's setup: the token file the first start writes opens a setup screen (set
      the password, enrol the app code, save the backup codes) instead of enrolling a browser key.
    - The client shows the TOTP secret and its `otpauth://` URI as text; a QR code needs an encoder
      the browser side may not import (OPEN-QUESTIONS A3) and can be hand-written later.
11. **Two settings move into the console.**
    - **SMTP** is §5.3's `smtp` setting with a form: host, port, TLS mode, user, password (sealed;
      *"SMTP credentials are credentials"*), from-address. The first version applies at once; every
      later version takes the delay and the quorum of (3). A test-send goes to the requesting
      operator's own address, rate-limited, sealed.
    - **Console placement** (hosts, sources) is a placement setting outside §5.3's delay, because
      tightening it gains an attacker nothing and loosening it already needs an operator session.
      Its risk is lockout, and the guard is **confirm or revert**: the change applies at once and
      is sealed (`console_placement_requested`); the page has warned, before the save, what happens
      next and how long there is; the client then redirects the browser to the new host; an
      operator sign-in on the new host inside the window confirms it (`console_placement_confirmed`);
      otherwise, at the window's end, the placement reverts to the last confirmed one, or to open
      if there was none (`console_placement_reverted`), and every operator session banners it. The
      window is a setting, default 5 minutes, from 1 to 60, and it cannot be turned off.
      `FATHOM_ADMIN_HOSTS` and `FATHOM_ADMIN_SOURCES` win when set, and the form says so and is
      read-only then. `fathom-server console-placement --reset` on the host clears a placement that
      locked everyone out, sealed, for the case where the window was confirmed and the host later
      died.
12. **Two headers.** A content security policy on every response the server serves, and HSTS when
    a trusted proxy says the request arrived over TLS. This closes OPEN-QUESTIONS C5.

## What it gives up

- §4.5's "the admin surface has no password path" is reopened on the owner's decision. What kept
  the route closed was that a password is a factor the server can re-issue; the guard now is that
  the app code is not mailed and not re-issuable by an operator, and that a mailed reset never
  restores the operator seat by itself (7). The property is weaker than the original by exactly
  one factor, and the ADR says so.
- The browser-held long-term key stops being the credential. The session keypair stays. The
  `account_keys` and `operator_keys` tables stay for the passkey step; they hold no rows for a
  password-only person.
- An operator now has an address, for notices and as their sign-in name.
- The explicit `FATHOM_SINGLE_OPERATOR` declaration becomes a derived, sealed fact.
- §6.3's "never from the host once a credential exists" becomes "from the host, recorded and
  noticed". What it protected against was already inside tier 3.
- Dependencies: a password hash (`argon2` and what it pulls), SHA-1 for TOTP, and an SMTP client
  with TLS, which is the largest single item and is not in the tree today. Counted against the
  ceiling (141 of 200 on 2026-09-21, revisit at 180), looked up at build time with `gate-zero`,
  never assumed.

## Cost and order

Five sessions, one migration, three new dependency closures.

1. **Server, credentials.** Migration 0016 (`accounts.password_hash`, TOTP secret and backup codes
   sealed, reset tokens, `operators.account_id`, the new entry types). Set-password and enrol-TOTP
   routes; sign-in by address, password and code, binding the session keypair as today; the
   first-operator setup token; reset tokens (without mail yet). Rate limits reused. Tests: the
   two refusal tests that forbade password-shaped fields are rewritten to name the one route that
   may carry one, and to assert the code is required for the operator custody.
2. **Server, operators.** Account binding, quorum `min(2, live)` with the delay and the derived
   single-operator fact, the standing warnings, `recover-operator`, the retired switch.
3. **Server, settings and headers.** The SMTP form data and test-send; console placement with the
   window and the revert sweep; `admin_exposure` reading the placement; the console-host flag to
   the client; the two headers.
4. **Client.** Sign-in; the setup and TOTP enrolment screens; forgot-password and reset; the
   console's settings pages with the placement warning, the redirect and the countdown; host-aware
   absence of every operator control; the operators page with add, disable and the one-operator
   banner. The CI sign-in script moves to the password flow.
5. **Mail and docs.** The SMTP client; reset by mail; notices for (3), (5) and (8); RUNNING-IT §5,
   OPERATING's drill, STATE, `.env.example`, `compose.yaml`.

## The owner's calls

Recorded in `docs/OPEN-QUESTIONS.md` C6, all answered 2026-09-21: the 24-hour wait on the first
colleague stands, the host recovery has no delay, and passwords are in, with the app code beside
them.
