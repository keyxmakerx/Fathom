# ADR-0057: A setup password in `.env`; Site behind the account; sessions that survive a reload

**Status:** accepted 2026-09-24, on the owner's answers to closed questions (2026-09-23 and
2026-09-24). **Amends** ADR-0055 decisions 2 and 10 (the token file) and ADR-0056 decision 2
step 1 (the Setup token field). **Answers** the root-private-key question in `docs/NEXT.md`.
Everything else in both ADRs stands. **Amended** 2026-09-25: decisions 6 to 8.

## The ask, in the owner's words

*"I don't like the idea of the sys admin being required to pull a code out of a file/log. I think
you should set the env variable for the email, and then maybe a yes or no for a 'start up' which
then walks you through setting up the organizer... However it needs to be very secure, but keep in
mind probably over 100 general enterprise users of various groups and priv levels will need access
to this tool."* Then: *"an env password that is temporary? but it's filled out in the env file"*.

## What was looked at

- `docs/archive/2026-09-22-first-run-survey.md` (read 2026-09-22): Portainer's log token is
  "replaceable by `--admin-password` for managed or marketplace installs where you may not have
  direct access to the server logs". Setup windows: Portainer 5 minutes, Uptime Kuma 3.0 10.
- Keycloak's server guide, `docs/guides/server/bootstrap-admin-recovery.adoc` (keycloak/keycloak
  main, read 2026-09-24): an admin created from environment variables "is *temporary*", is created
  "only during the initial start", and "the Administration Console warning banner, labels, and log
  messages" say so until it is replaced.
- OWASP ASVS 5.0.0 (May 2025), read 2026-09-23: 6.2.3 (L1) password change needs the current
  password; 6.3.3 (L2) multi-factor to reach the application; 7.3.1 and 7.3.2 (L2) an idle timeout
  and an absolute lifetime; 7.4.3 (L2) end other sessions after a factor changes; 7.5.1 (L2) full
  re-authentication before changing a factor; 7.5.3 (L3) a further factor before highly
  sensitive operations.

## Decisions

1. **First start takes a setup password from `.env`.** `FATHOM_SETUP_PASSWORD` sits beside
   `FATHOM_OPERATOR_NOTICE_ADDRESS`. The Welcome screen asks for it where it asked for the Setup
   token; the rest of ADR-0056's five screens are unchanged.
   - At least 15 characters, as for any password. Shorter, or unset: setup stays closed and the
     log says which, and how to fix it.
   - Compared in constant time; wrong guesses spend the existing per-source budget.
   - Works once: spent when the first operator's password is set.
   - Open for 30 minutes after the server starts. After that, setup is closed until a restart.
   - While the variable is still set after setup, every start logs a warning to remove it.
   - The same password opens the adoption path (ADR-0055 decision 2, amended).
   - No token file is written at first start. `fathom-server recover-operator` keeps its one-shot
     code printed on the host; it is break-glass, not setup.
2. **Site needs the account.** Entering Site needs the same person's live account session, and a
   fresh verification code when that session's second-factor proof is over 15 minutes old. The
   operator key alone no longer opens a session.
3. **Changing a factor is re-authenticated and ends other sessions.** A password change needs the
   current password. Changing the authenticator needs the password and a current code. Either ends
   every other session of the account. The account screen shows whether an authenticator is set.
4. **A reload keeps you signed in, in the same tab.** The session keypair stays non-extractable and
   is kept in IndexedDB, keyed to the tab; sign-out and expiry delete it. The server ends a session
   after 1 hour idle (15 minutes on the operator plane) and 12 hours at most.
5. **The organisation claim is part of setup, and its root key is shown once.** The browser makes
   the organisation's root keypair, signs the genesis grant, and shows the private key once as the
   organisation's **recovery key**, to download or print, with "I have saved this" before going on.
   The browser then forgets it; the server never receives it.

## Amendment, 2026-09-25: what a reload keeps

The owner left this to the lead ("decide based off what others say and do"), with two limits: it
must work in Firefox, and stay usable for a normal person and for an admin who is not always setting
up and cleaning up. Research read 2026-09-25: the WebCrypto spec and the Chromium, Firefox and WebKit
sources (a stored key stays non-extractable, but Chromium writes its raw bytes to the profile);
mdn/browser-compat-data (Web Locks from Firefox 96, BroadcastChannel from 38); the OWASP Session
Management Cheat Sheet ("Binding the Session ID to Other User Properties": an address check detects
hijacking but a shared NAT or proxy defeats it); NIST SP 800-63B-4 (at AAL2, idle no more than 1 hour
and overall no more than 24; session secrets should not persist across a restart); and, from search
results only (the pages are blocked here), Okta ending admin console sessions when their address
changes, on by default.

6. **Site is not kept across a reload.** Decision 2's 15-minute grace lives only in the tab's
   memory. After a reload, or from a copied browser profile, opening Site needs a fresh code. The
   account session is kept, as decision 4 says.
7. **Site is tied to its address.** A Site session ends when a request comes from another address
   (IPv4 exactly, IPv6 by its /64), and the person opens Site again with a code. An address change
   does not end an account session: laptops, VPNs and phones change address, and mainstream
   products do not sign people out for it. The change is recorded with the session.
   `FATHOM_SESSION_ADDRESS_CHECK` is `site` (the default), `all` or `off`.
8. **Signed-in browsers are listed.** Each person can see their signed-in browsers (browser, address,
   last active) and sign any of them out (ASVS 5.0.0 7.5.2). Admins get the same list for everyone
   with People and permissions (7.4.5). A new browser needs the password and a code, not an admin's
   approval. To stop a person, disable the account, which ends every session (7.4.2).

## What it gives up

- A secret in `.env` lives on the host's disk until removed. So does every key in ADR-0043, and the
  start-up warning names it.
- A reload no longer asks for the password. A stolen unlocked laptop keeps the tab's session until
  the idle timeout, as any web session does.
- A lost recovery key cannot be re-shown. Break-glass for that organisation then needs its stewards.
- The address check is a tripwire, not a lock: someone on the same network shares the address. A
  copied profile used from that network lasts until the idle limit.

## Order of work

A: the setup password (server, client Welcome, `scripts/ci/first-operator-signin.mjs`,
`docs/RUNNING-IT.md`, `docs/OPERATING.md`). B: Site behind the account, and factor changes. C: the
reload, the timeouts and decisions 6 and 7; then decision 8's own list. D: the claim route and the
recovery key. A checker attacks each stream before it is merged.
