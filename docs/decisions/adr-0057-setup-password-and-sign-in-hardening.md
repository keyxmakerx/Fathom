# ADR-0057: A setup password in `.env`; Site behind the account; sessions that survive a reload

**Status:** accepted 2026-09-24, on the owner's answers to closed questions (2026-09-23 and
2026-09-24). **Amends** ADR-0055 decisions 2 and 10 (the token file) and ADR-0056 decision 2
step 1 (the Setup token field). **Answers** the root-private-key question in `docs/NEXT.md`.
Everything else in both ADRs stands.

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

## What it gives up

- A secret in `.env` lives on the host's disk until removed. So does every key in ADR-0043, and the
  start-up warning names it.
- A reload no longer asks for the password. A stolen unlocked laptop keeps the tab's session until
  the idle timeout, as any web session does.
- A lost recovery key cannot be re-shown. Break-glass for that organisation then needs its stewards.

## Order of work

A: the setup password (server, client Welcome, `scripts/ci/first-operator-signin.mjs`,
`docs/RUNNING-IT.md`, `docs/OPERATING.md`). B: Site behind the account, and factor changes. C: the
reload and the timeouts. D: the claim route and the recovery key. A checker attacks each stream
before it is merged.
