# First-run and sign-in survey: ten self-hosted products (2026-09-22)

Research for ADR-0056. Read on 2026-09-22 by a research agent; GitHub docs folders and UI
source were used where vendor sites were blocked by egress (grafana.com, docs.portainer.io,
gitea.com, forgejo.org, codeberg.org). Search extracts are marked as such. This is the evidence;
the decision is in `docs/decisions/adr-0056-first-run-and-sign-in.md`.

## The common shape

1. **The server decides, the browser is redirected.** Eight of ten detect "no administrator
   yet" server-side and send every visitor to a dedicated create-the-first-administrator page.
   Persisted flag: Nextcloud `installed` (`lib/OC.php`), Gitea `INSTALL_LOCK`
   (`routers/install/install.go`), Home Assistant's onboarding store. Live query: Portainer
   `UsersByRole(Administrator)` (`api/adminmonitor/admin_monitor.go`), Immich `hasAdmin()`
   (`server/src/services/base.service.ts`), Uptime Kuma `count(user) == 0` (`server/server.js`),
   Authentik "akadmin has no usable password" (`blueprints/default/flow-oobe.yaml`). **No product
   shows a normal sign-in page with a "first setup" link.** Exceptions: Grafana (fixed
   `admin`/`admin`, client-side forced change with a Skip button), Vaultwarden (no admin user;
   operator-set `ADMIN_TOKEN`), Proxmox (OS root).
2. **The first page is one short form**: username or email, password, confirm password,
   sometimes a language or instance name. Immich: "Since you are the first user on the system,
   you will be assigned as the Admin…" Portainer: "Please create the initial administrator
   user." Password rules inline (Portainer "at least 12 characters", Nextcloud "at least
   'strong'", Home Assistant "Choose a strong and unique password. Make sure to save it").
3. **Nobody enrols 2FA during first run.** TOTP is an opt-in later step from the profile or
   security page (Gitea, Nextcloud, Home Assistant, Uptime Kuma, Authentik, Proxmox, Bitwarden).
   Enrolment always shows a **QR code plus the manual secret as text** (all seven). Backup codes
   vary: Nextcloud 10 × 16 characters, Gitea one scratch code, Proxmox one set of recovery keys,
   Bitwarden a recovery code; Home Assistant, Uptime Kuma and Authentik's TOTP stage show none.
4. **Proof-of-host is rare and recent.** Only Portainer requires a token from the server logs,
   added in 2.43 / 2.39.4 after advisory GHSA-x626-fcwx-f5pc ("Unauthenticated Restore and
   Admin-Account-Creation Endpoints Allow Admin Takeover on Uninitialised Portainer Instances",
   published 2026-07-02). It is one-time, a labelled "Setup token" field on the create-admin page
   with the tooltip "Find this token in the Portainer server logs", rendered only when the server
   requires it (`$scope.requiresSetupToken = data.RequiresSetupToken`), and on 403: "Setup token
   is missing or invalid. Find the current token in the Portainer server logs." Replaceable by
   `--admin-password` "for managed or marketplace installs where you may not have direct access to
   the server logs". Time windows: Portainer 5 minutes ("the Portainer service within the
   container stops… a security measure to prevent a malicious user taking over a fresh Portainer
   installation"), Uptime Kuma 3.0 10 minutes ("Setup has expired. Please restart the server").
5. **Sign-in page = two fields, one button, 0–2 links.** Identifier + password everywhere; links
   are "Forgot password?" (Grafana, Gitea, Nextcloud, Home Assistant) and a register link only
   where open registration is on. **The second factor is never on the first page**: a separate
   page after the password (Gitea `/user/two_factor`, Nextcloud challenge page, Authentik stage,
   Bitwarden), a second step of the same flow (Home Assistant), a modal (Proxmox), or a field
   swapped into the same form after the server answers `twoFactorRequired` (Uptime Kuma).
6. **Recovery is a CLI command, universally**, plus mail reset where SMTP exists:
   `grafana cli admin reset-admin-password`, `portainer/helper-reset-password`,
   `gitea admin user change-password`, `occ user:resetpassword` / `occ twofactorauth:disable`,
   `ak changepassword` / `create_recovery_key`, `immich-admin reset-admin-password`,
   `hass --script auth change_password`, `npm run reset-password`, `pveum user tfa unlock`.
   Upgrades never re-enter first run; Portainer says so ("Existing deployments are unaffected").
7. **Rationale the products give.** Portainer: "protect a freshly started instance from being
   claimed by someone other than the intended administrator". Grafana: "Continuing to use the
   default password exposes you to security risks." Authentik: "Pretend user exists" against
   enumeration; "This recovery key will give whoever has the link direct access". Home Assistant:
   a dummy secret so a TOTP check costs the same time with or without one. Nextcloud: generic
   "Wrong login or password." plus 30-second throttling. Proxmox: second factors "blocked for an
   hour" after limits. Immich: deliberately no TOTP.

## What the TOTP factor is called

| Product | Method name | Code field at sign-in |
|---|---|---|
| Gitea | "Two-Factor Authentication (TOTP)" | "Passcode" |
| Nextcloud | "TOTP (Authenticator app)" | "Authentication code" |
| Authentik | "TOTP" (enrolment "TOTP Code") | "Authentication code" |
| Home Assistant | "Authenticator app" | "Two-factor authentication code" |
| Uptime Kuma | "2FA" / "Two Factor Authentication" | "Token" |
| Proxmox | "TOTP App" | "Please enter your TOTP verification code" |
| Bitwarden client | "Authenticator app" (under "Two-step login") | "Verification code" |
| Grafana OSS, Portainer CE, Immich | no native TOTP | — |

Method wording containing "Authenticator app": 3. Code field "Authentication code": 2. Page
heading "Two-factor authentication": 4. **Nobody labels the field "app code".**

## Per-product sources (all read 2026-09-22)

- Grafana: `docs/sources/setup-grafana/configure-grafana/_index.md`, `public/app/core/components/Login/LoginCtrl.tsx`, `…/ForgottenPassword/ChangePassword.tsx`, `…/Login/LoginForm.tsx`, `…/Login/LoginPage.tsx`, `docs/sources/administration/cli.md` (raw.githubusercontent.com/grafana/grafana/main); MFA: search extracts of grafana.com docs and whats-new 2026-06-02; issue grafana/grafana#116458.
- Portainer: `api/adminmonitor/admin_monitor.go`, `api/cmd/portainer/main.go`, `api/cli/cli.go`, `app/portainer/views/init/admin/initAdmin.html`, `…/initAdminController.js` (portainer/portainer, develop); docs repo portainer/portainer-docs branch 2.39: `start/install/server/setup.md`, `faqs/installing/setup-token.md`, `faqs/installing/your-portainer-instance-has-timed-out-for-security-purposes-error-fix.md`, `admin/settings/authentication/README.md`, `advanced/reset-admin.md`; advisory github.com/portainer/portainer/security/advisories/GHSA-x626-fcwx-f5pc.
- Gitea: `routers/install/install.go`, `templates/install.tmpl`, `options/locale/locale_en-US.json`, `routers/web/auth/auth.go`, `cmd/admin_user_create.go`, `cmd/admin_user_change_password.go`, `templates/user/auth/signin_inner.tmpl`, `templates/user/auth/twofa.tmpl`, `twofa_scratch.tmpl`, `templates/user/settings/security/twofa_enroll.tmpl` (go-gitea/gitea, main). Forgejo hosts blocked; search extract of docs.codeberg.org/security/2fa/.
- Nextcloud: `lib/OC.php`, `core/l10n/en_GB.json`, `core/src/components/login/LoginForm.vue`, `core/src/views/Login.vue`, `core/templates/twofactorselectchallenge.php`, `apps/twofactor_backupcodes/lib/Service/BackupCodeStorage.php` (nextcloud/server, master); `admin_manual/installation/installation_wizard.rst`, `admin_manual/configuration_user/reset_admin_password.rst`, `admin_manual/configuration_user/two_factor-auth.rst`, `user_manual/user_2fa.rst` (nextcloud/documentation); `l10n/en_GB.json` (nextcloud/twofactor_totp).
- Vaultwarden: `.env.template`, `src/static/templates/admin/login.hbs` (dani-garcia/vaultwarden); wiki pages Disable-registration-of-new-users, Enabling-admin-page; Bitwarden client strings `apps/web/src/locales/en/messages.json` (bitwarden/clients).
- Authentik: `website/docs/install-config/install/docker-compose.mdx`, `…/automated-install.mdx`, `blueprints/default/flow-oobe.yaml`, `blueprints/default/flow-default-authentication-flow.yaml`, `website/docs/add-secure-apps/flows-stages/stages/identification/index.mdx`, `web/src/flow/stages/authenticator_validate/AuthenticatorValidateStageCode.ts`, `web/src/flow/stages/authenticator_totp/AuthenticatorTOTPStage.ts`, `website/docs/troubleshooting/login.mdx` (goauthentik/authentik).
- Immich: `server/src/services/base.service.ts`, `server.service.ts`, `docs/docs/install/environment-variables.md`, `docs/docs/partials/_register-admin.md`, `web/src/routes/auth/login/+page.ts`, `web/src/routes/auth/register/+page.svelte`, `i18n/en.json`, `docs/docs/administration/server-commands.md` (immich-app/immich); discussions #8175, #23339 (search extracts).
- Home Assistant: `homeassistant/components/frontend/__init__.py`, `components/onboarding/const.py`, `components/onboarding/__init__.py`, `homeassistant/core_config.py`, `homeassistant/auth/mfa_modules/totp.py`, `homeassistant/components/auth/strings.json` (home-assistant/core, dev); `src/translations/en.json` (home-assistant/frontend); `source/getting-started/onboarding.markdown`, `source/_docs/authentication/multi-factor-auth.markdown`, `source/_docs/locked_out.md` (home-assistant.io, current).
- Uptime Kuma: `server/server.js` (1.23.X), `server/routers/better-auth-router.ts`, `src/pages/Setup.vue`, `src/components/Login.vue`, `src/components/TwoFADialog.vue`, `src/lang/en.json` (louislam/uptime-kuma, master); wiki Reset-Password-via-CLI.
- Proxmox VE: `pveum.adoc` (proxmox/pve-docs), `www/manager6/window/LoginWindow.js` (pve-manager), `src/window/TfaWindow.js`, `src/window/AddTotp.js`, `src/window/AddTfaRecovery.js` (proxmox-widget-toolkit).
