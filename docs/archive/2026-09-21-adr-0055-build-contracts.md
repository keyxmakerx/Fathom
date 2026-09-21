# ADR-0055 build contracts — 2026-09-21

Builders are pointed here by name. Kept in `docs/archive/` because it is history the day it is
superseded by shipped code, not because it is not current today.

**Numbering correction, reported first because three streams depend on it.** The ADR's prose says
"migration 0016" throughout. There is no `0016` on disk — `0015_operator_console.sql` retired the
number in place (see that file's section B2) — and `migrate.rs` already registers version 17
(`0017_firmware_staging.sql`). The next free number is **18**. This document's three migrations are
`0018_credentials.sql`, `0019_operator_account_binding.sql`, `0020_console_placement.sql`, already
written, registered in `src/migrate.rs`, and green against a live database (result line at the
bottom). `0017_firmware_staging.sql` line 9 falsely says 0016 shipped; whoever next edits that file
should drop the claim, but this document does not edit a shipped migration to fix a comment.

**One schema decision beyond the three migrations' own headers, flagged here because it is easy to
miss:** `0018` adds a third `sessions.assurance` value, `'A0T'` (password + verified TOTP, no
long-term key), alongside `0013`'s `'A0'`/`'A1'`. See `0018` section B2. **What an `A0T` session may
do is not decided by any migration and is this document's first open issue.**

---

## Stream (a) — credentials

Schema: `0018_credentials.sql`. New module `src/credentials.rs`. Two new capabilities:
`app.credential_custody` (self-service, held by a verified session acting on its own account) and
`app.reset_custody` (unauthenticated forgot/reset, no session exists). `app.session_custody`
(`0013`) is reused for the read-and-verify-inline step of sign-in itself.

### Routes

| Route | Signed | Request | Answer | Rate bucket |
|---|---|---|---|---|
| `POST /session` (widened) | no | `LP(kind)‖LP(session_pubkey)‖LP(nonce)‖LP(evidence_sig)‖LP(password)‖LP(totp_code)` — 6 fields, `read_fields(body,6)` | `LP(session_id)‖LP(token)‖u64(expires)‖LP(account_id)` unchanged | `sign_in_attempts`, existing |
| `POST /credentials/password` | yes | `LP(new_password)` | 200 empty | `credential_custody`, per-account, reuse `sign_in_attempts` bucket `password:<account>` |
| `POST /credentials/totp/enrol` | yes | empty | `LP(otpauth_uri)‖LP(secret_base32)` | one per session (latch, `0015`-shaped) |
| `POST /credentials/totp/confirm` | yes | `LP(totp_code)` | `LP(backup_code)×10` (ten LP fields) | 5 attempts / 10 min, per session |
| `POST /credentials/reset` | no | `LP(address)` | 200 empty always (anti-enumeration, decision 7) | `reset:<account>` / `reset:<source>` inside `sign_in_attempts`, no new table |
| `POST /credentials/reset/redeem` | no | `LP(token)‖LP(new_password)` | 200 empty | one attempt per token (single use; a wrong password on a live token is a typed refusal, not a second chance — token still spends: decision 7's "single use") |
| `POST /enrolment/operator/setup` | no | `LP(token)‖LP(new_password)` | `LP(otpauth_uri)‖LP(secret_base32)` (then `POST /credentials/totp/confirm` on the resulting `A0T` session) | one per token |

`read_fields` keeps its exact-count refusal (400 on a mismatched count) everywhere, per `api.rs`
`read_fields` (:498) and `admin.rs` (:607).

**Widening `POST /session`, exactly.** `sessions::sign_in` (:1152) / `attempt_sign_in` (:1286): for
`kind='steward'` or `'operator'` with a non-empty `password` field, verify password + TOTP **between
step (3) and step (4)** of the existing sequence (after the nonce is consumed and the principal
resolved, before/instead of `verify_es256` at :1489):

1. `password` empty and `evidence_sig` non-empty → today's path, unchanged, byte-identical.
2. `password` non-empty → look up `accounts.password_hash`; `argon2::verify_password`; on mismatch,
   `SessionError::PasswordRefused` (mapped to the SAME sentence the wrong-signature case gives —
   decision 7 / ASVS 6.3.8, no account enumeration through message or timing). If
   `totp_enrolled_at IS NOT NULL`, require `totp_code` non-empty and verify it (§ below); if it is
   NULL and the account holds the operator custody (via `operator_account_bindings`), refuse with a
   typed error telling the client to go to `/credentials/totp/enrol` first — the account is mid
   setup. `live_signing_key` (:1403 / `live_operator_key` :1460) is **not called** on this path —
   `NoSigningKey` is the expected state for a password-only person and must not be treated as a
   refusal. `verify_es256` (:1489) is skipped. `chains::append_site` (:1509) files `AccountSignin` /
   `OperatorSignin` exactly as today; `assurance` is `'A0T'` when a code was checked, `'A0'` when the
   account has no TOTP and holds no operator custody (steward-only, still allowed to sign in and
   change its own password, per design doc §5.1).
3. Both empty → today's `SessionError` for a malformed body, widened to name the sixth field.

**TOTP verification.** `code = HOTP(K, unix_time/30)` per RFC 6238, SHA-1, 6 digits. Accept the
current step and one step of skew (decision 10): check `step-1, step, step+1` against
`totp_last_step`; refuse if the accepted step is `<= totp_last_step` (replay); on success,
`UPDATE accounts SET totp_last_step = accepted_step` in the SAME transaction as the session insert.
**Test named in the risks:** replay of the SAME code inside the same 30-second step must be refused
the second time even though it verifies (CLAUDE.md rule 2) — this is the `<=` and not `<`.

**Backup code as a TOTP substitute at sign-in.** `totp_code` may instead be an 11-character
prefixed backup code (distinguished from a 6-digit TOTP code by length, per decision 10's "for the
lost phone"); look up `H(LP(tag)‖LP(code))` in `backup_codes` where `used_at IS NULL`, spend it with
`UPDATE ... WHERE used_at IS NULL RETURNING`, write `BackupCodeUsed` with `chain_seq`.

### Entry types (site chain, `0018` section F)

| Type | Written by | Metadata |
|---|---|---|
| `password_set` | set/change password, reset redeem | `account_id`, `was_reset: bool` |
| `totp_enrolled` | confirm-TOTP | `account_id` |
| `reset_requested` | `POST /credentials/reset` | `account_id`, `source` |
| `reset_spent` | `POST /credentials/reset/redeem` | `account_id`, `token_id` |
| `backup_code_used` | sign-in or explicit spend | `account_id` |

### Functions changed / tests rewritten

- `sessions::sign_in` / `attempt_sign_in` — signature unchanged (still takes the raw body bytes);
  internal branch added. `api::sign_in_handler` — `read_fields(&body, 4)` → `read_fields(&body, 6)`.
- **Rewritten, by name, to name the one route and the one column rather than forbid the word:**
  `sessions.rs:3148` (`no_message_in_this_module_has_a_field_a_password_could_arrive_in`) →
  asserts the field exists in exactly `sign_in_handler`'s body parse and nowhere else in the module.
  `tests/operators.rs:2379` (`no_wire_type_in_this_server_has_a_field_a_password_could_arrive_in`) →
  same, scoped to `api.rs`'s `sign_in_handler` and `credentials.rs`'s three routes; every other
  handler in `api.rs`, `admin.rs`, `operators.rs` still forbidden outright.
  `tests/operators.rs:2413` (`the_schema_has_no_column_a_password_could_be_stored_in`) → allowlists
  exactly `accounts.password_hash`; every other `%password%`/`%passphrase%`/`%passcode%`/`pin` match
  in `information_schema.columns` still fails the test.
  `tests/sessions.rs:1133` (`the_operator_sign_in_surface_accepts_no_password_shaped_input`) →
  **deleted**, decision 10 explicitly reopens exactly this. A new test,
  `an_operator_session_requires_totp_before_it_is_usable`, replaces it: an operator-custody account
  with `totp_enrolled_at IS NULL` cannot reach `A0T` or `A1`.
- `tests/sessions.rs` key-based helpers (`sign_in*` and the ~30 line refs the sessions scout named)
  are unaffected — they exercise branch 1 above, byte-identical.
- `tests/session_vectors.rs` — `session_row_mac` vectors unaffected (assurance is inside
  `session_row_state`'s covered fields per `0013`; a new legal VALUE for an existing covered field
  does not change which bytes are covered — confirm this reading against `session_row_state`, :2568,
  before relying on it; flagged as **unverified**, no test run against it this session).
- `no_key_protected_data.rs` `TABLES` (:89) — needs four new entries: `backup_codes`
  (`NoKeyProtectedMaterial` — a SHA-256 hash, not a key-protected secret), `password_reset_tokens`
  (`NoKeyProtectedMaterial`, same reasoning as `enrolment_tokens`), and on `accounts`:
  `totp_secret_ct`/`totp_secret_nonce`/`totp_secret_key_epoch` as `KeyProtected` (naming the
  `fathom/credentials/totp/v1` HKDF label), `password_hash` as `NoKeyProtectedMaterial` (it is
  already a one-way hash, not a key-wrapped secret — see `0018` section A). **Not fixed by this
  session**; the test will fail on today's code as soon as these columns exist, which is correct —
  it is supposed to.
- `admin_exposure.rs` — **unchanged by this stream**, but stream (a)'s new routes must be added to
  neither `covers()` nor the exposure gate: they are account-plane, reachable on every host, exactly
  like `/session` today.

### Constants

- Password: **15–128 characters** (ADR-0055 decision 10 / NIST 800-63B-4 §3.1.1.2, cited in the
  ADR), no composition rule, no expiry. Refused if on a bundled common-password list or contains the
  account's address (case-insensitive substring). **List location: not chosen by this session** —
  needs an owner-approved source and its own line in `deps/decisions/` if it ships as a crate (e.g.
  a `Have I Been Pwned`-derived static list) rather than a vendored text file with a licence note.
  Flagged as open issue 2.
- Argon2id parameters: **looked up at build time against the OWASP Password Storage Cheat Sheet's
  current figures, not fixed here** (ADR decision 10 says so explicitly; CLAUDE.md rule 1 forbids
  fixing them from memory in this document).
- TOTP: RFC 6238, SHA-1, 6 digits, 30-second step, ±1 step skew, replay refused via `totp_last_step`.
- Reset token: 32 bytes (256 bits) from the OS CSPRNG — **wider than decision 7's "at least 128
  bits" floor**, chosen to match `enrolment_tokens`' existing 32-byte convention rather than invent
  a second size. 24-hour lifetime (decision 7).
- Backup codes: 10 per enrolment, each ≥ 80 bits from the OS CSPRNG, rendered in a form decision
  10 leaves to the client (the existing 64-hex-character convention, `PHASE-2-ADMIN-AND-AUDIT-DESIGN.md`
  §4.4, is the nearest precedent — not mandated here, flagged as open issue 3).

### First-operator setup, end to end

1. First start, no operator exists: `bootstrap_first_operator` (unchanged shape) now (a) creates an
   `accounts` row for `FATHOM_OPERATOR_NOTICE_ADDRESS` if none exists, (b) creates the `operators`
   row as today, (c) `INSERT INTO operator_account_bindings` sealed, (d) issues a purpose=`'setup'`
   token (not `'operator'`) via `operators::issue_token`, written to the bootstrap token file exactly
   as today. **Signature change**, named: `bootstrap_first_operator` gains an `&Transaction` need for
   the accounts insert it does not have today (it already runs in one).
2. The client reads the token file's contents (operator's own act, out of band), opens the setup
   screen, and calls `POST /enrolment/operator/setup` with the token and a chosen password.
3. The server spends the token (`UPDATE ... WHERE redeemed_at IS NULL RETURNING`, `0015` §E's
   shape), sets `accounts.password_hash`, writes `password_set` and `enrolment_token_redeemed`, and
   returns a fresh `A0T`-track sign-in (client then signs in with `POST /session` branch 2 to get a
   real session, or the setup route returns a session directly — **builder's call, not fixed here**,
   flagged as open issue 4 because it changes whether step 4 needs a second round trip).
4. The client immediately calls `POST /credentials/totp/enrol` then `/confirm`, shows the ten backup
   codes once, and only then lets the operator past the setup screen — decision 10's "taken to the
   enrolment screen before anything else."

---

## Stream (b) — operators

Schema: `0019_operator_account_binding.sql`. **Reports one departure from the ADR's literal text**:
no `operators.account_id` column. `operators.row_seal` covers five fields
(`operators.rs::operator_row_seal`, :3629) computed under a key not in PostgreSQL; a column outside
that seal is forgeable by a database holder, and a column inside it needs every existing row
re-sealed, which a migration cannot do (the migration role does not hold the chain master — the same
argument `0015` §B2 gives against the trigger it removed). Built instead: `operator_account_bindings`,
append-only, its own seal, one row per operator, `UNIQUE(account_id)`. See the migration's header for
the full argument.

### Routes

| Route | Signed | Request | Answer |
|---|---|---|---|
| `POST /admin/operators` (existing, quorum path) | yes | unchanged `LP(name)‖LP(assertion)` | unchanged — now also inserts a pending binding to a NEW account created alongside (name doubles as address? **not decided — open issue 5**: decision 5's "add the successor" implies the new operator has an address from the start, but §1.1's existing route takes only a display name) |
| `GET /admin/operators` (existing) | yes | — | text lines gain a column: `id name created_by never_signed_in disabled live_count_floor_note` — **exact line format not fixed here**, builder's call within `admin.rs`'s existing text-line convention |
| `POST /admin/operators/recover` | **CLI only, not HTTP** | `fathom-server recover-operator <address>` | prints a ten-minute one-shot setup code to stdout |

`recover-operator` folds in `reissue-bootstrap-token` (decision 8): it works for ANY existing,
non-disabled operator (not only the un-enrolled bootstrap case `reissue-bootstrap-token` refuses
after), runs where the key volume is mounted, needs no delay ("the host already holds every key"),
and writes `operator_recovered_from_host` (added in `0019`), notifies every live operator, and sets a
seven-day banner flag — **the banner's storage is not decided here**: reusing `single_operator`-style
"written at every startup" is one option, a dedicated `recovered_until` column on nothing (there is
no natural row to put it on) is another. Open issue 6.

### Quorum, single-operator, and the floor

`FATHOM_SINGLE_OPERATOR` is retired (decision 3). `OperatorStore.single_operator` (a stored `bool`
field today, `operators.rs:584`) becomes a method: `COUNT(*) FROM operators WHERE disabled_at IS NULL`
compared to 1, called wherever `self.single_operator` is read today (`request_setting`,
`apply_if_due` per the scout's note that it "re-reads... the LIVE `self.single_operator()`" already —
so this is a rename to match behaviour already half-built, not new behaviour). **Startup refusal
message if `FATHOM_SINGLE_OPERATOR` is still set in the environment**: `main.rs` logs and refuses to
start, naming the variable and ADR-0055 decision 3, rather than silently ignoring a now-meaningless
setting — CLAUDE.md rule 2's spirit (a stale switch someone believes still works is worse than a
refusal).

`0019` section C adds `fathom_operator_floor`, a `SECURITY DEFINER` trigger refusing `disable_operator`
when it would take the live count to zero. It does **not** raise the floor to two — decision 4 keeps
a sole operator a supported, standing-warned shape.

### Entry types

`operator_recovered_from_host` only (section D). `min(2, live)` operator creation reuses `0015`'s
existing `operator_created`/`operator_seconded`/`operator_enrolled` — no new types needed; the scout's
"beyond 0015" gap was the floor and the account binding, both covered above, not new entry types.

### Functions changed / tests rewritten

- `operators::bootstrap_first_operator` — see stream (a) step 1.
- `operators::OperatorStore::single_operator` — field → async method querying `operators`.
- `main.rs` — refuse-and-exit on `FATHOM_SINGLE_OPERATOR` being set; `config.rs` — the variable's
  parse stays (so the refusal message can name what was set) but nothing reads its VALUE for
  behaviour any more.
- `tests/operators.rs` fixtures depending on `single_operator=true`/`false` as a store constructor
  argument (the ~25 line references the scout names, 390 through 2573) — **all rewritten** to seed
  live operator rows instead of passing a bool, because the field they construct no longer exists.
  This is the single largest test-touching change in the whole ADR and is why stream (b) is its own
  session (cost/order item 2).
- `admin.rs::disable_operator` handler — unchanged signature; the new trigger turns a would-be silent
  success into a typed refusal the handler must map (`AdminRefusal` gains one variant).

---

## Stream (c) — placement and settings

Schema: `0020_console_placement.sql`. **Nothing for SMTP beyond `site_settings_versions`** (`0015`
§F) — `smtp` is one more `key`, sealed the same way every other setting is. Say so, as instructed:
there is no SMTP table in this migration.

### SMTP value layout (inside `value_ct`, plaintext before sealing)

`LP(host)‖LP(port as text)‖LP(tls_mode)‖LP(user)‖LP(password)‖LP(from_address)`. `tls_mode` is one of
`starttls`/`implicit`/`none` (text, not an int, so a malformed row is legible in a dump without the
enum table). **"SMTP credentials are credentials"** (`0015` §F's own comment) — the password field
inside this envelope gets no special treatment beyond what the envelope already gives every field:
sealed under `KDF_SITE_SETTINGS`, never logged (see the new gate below), and readable only under
`app.operator_custody`.

### Routes

| Route | Signed | Request | Answer |
|---|---|---|---|
| `POST /admin/settings` (existing) | yes | unchanged `LP(key)‖LP(value)‖LP(assertion)` — `key='smtp'` is the new case | unchanged `LP(id)‖u64(effective_at)` |
| `POST /admin/settings/{id}/test-send` | yes | empty | 200 empty or typed refusal | rate-limited: one per operator per 5 minutes, reusing `sign_in_attempts`-shaped bucket `smtp-test:<operator>` — **no new table**, same reasoning as stream (a)'s reset buckets |
| `POST /admin/placement` | yes | `LP(hosts)‖LP(sources)‖LP(assertion)` | `LP(id)‖u64(confirm_by)` | — |
| `POST /admin/placement/confirm` (called by signing in on the NEW host) | implicit — signing in there IS the confirmation | — | — |
| `fathom-server console-placement --reset` | CLI only | — | writes `reverted_at`/`revert_reason='host_reset'`, sealed |

Test-send goes only to the requesting operator's own `accounts.email` via the binding in
`operator_account_bindings` (decision 11) — never an address in the request body, so there is no
field to abuse as an open relay probe.

### Placement's interlock, exactly

Unlike a setting, placement applies **at once** and is sealed in the same transaction
(`0020`'s `sealed_seq NOT NULL` from `INSERT`). The window (`window_seconds`, default 300, bound
60–3600 by both the `CHECK` and the `console_placement_window_seconds` site setting that supplies the
default) runs from `requested_at` to `confirm_by`. `admin_exposure::AdminExposure` reads the newest
row with `confirmed_at IS NOT NULL OR (reverted_at IS NULL AND confirmed_at IS NULL)` — i.e. the last
confirmed placement, or an unconfirmed one still inside its window — in preference to
`FATHOM_ADMIN_HOSTS`/`FATHOM_ADMIN_SOURCES`, which win outright when set (decision 11) and make the
console form read-only, showing why.

**A sweep** (called from the same place `apply_due_operator_requests` is swept from today, per
`admin.rs:289`'s existing pattern) finds rows with `confirmed_at IS NULL AND reverted_at IS NULL AND
confirm_by < now()`, sets `reverted_at`/`revert_reason='window_expired'`, and writes
`console_placement_reverted` — reverting to the last confirmed placement, or to "open" (no row)
if none exists, exactly as decision 11 states.

### The console-host flag — decision 9, unauthenticated, outside `/admin`

New route, **not under `/admin`** and **not `/enrolment/operator`** (the admin_exposure risk:
placing it there 404s exactly where the answer "no" is needed):

| Route | Signed | Answer |
|---|---|---|
| `GET /placement/flag` | no | `LP("yes"\|"no")` — this host matches the confirmed/pending placement (or the env vars, when set) |

Reads under the new `app.placement_flag` capability (`0020` section B) — a THIRD capability on this
table, deliberately narrower than `app.operator_custody`: it can `SELECT` two columns and nothing
else, from an otherwise-uncustodied, unauthenticated connection. **Must be added to
`lib.rs::router`** (today serves only `/health` and `/schema/kinds`) **and to `client/vite.config.ts`'s
proxy list** (today five prefixes, none of them this one) — both named because the sessions/client
scout confirms a 404-from-Vite-not-the-server failure mode if only one is done.

### Two headers (decision 12)

CSP and HSTS, on every response. **Exact directive values are not fixed in this document** — CLAUDE.md
rule 1: naming a CSP policy from memory is exactly the security-question-from-memory this rule
forbids. The builder looks up the OWASP Secure Headers project's current recommendation at build
time and records the citation and date the same way ADR-0055 itself did for NIST/OWASP. Open issue 7.
`.context/conventions.md` invariant 1's `default-src 'none'` shape (written for the client artifact)
is the nearest precedent for the DIRECTIVE STRUCTURE, not for the values — the server's CSP has a
different origin story (serving its own SPA plus API responses) and must be derived, not copied.

### Entry types

`console_placement_requested`, `console_placement_confirmed`, `console_placement_reverted` (`0020`
section C). No new type for SMTP — it is an ordinary `setting_requested`/`setting_applied` pair.

### Functions changed / tests rewritten

- `admin_exposure.rs::AdminExposure` — gains a DB-backed placement read beside its existing env-var
  read; `covers()`/`allows()` signatures likely gain a pool or a pre-fetched placement value —
  **exact shape not fixed here**, builder's call, but `tests/admin_exposure.rs:37,175` both need a
  placement fixture added alongside the existing env-var one.
  **A real gap, reported rather than solved**: today `AdminExposure::covers()` matches only
  `/admin*` and `/enrolment/operator` (scout, CONFIRMED) — `/session` and `/session/challenge` for
  `kind='operator'` are reachable on every host regardless of placement. This stream does not close
  that gap; it is orthogonal to placement (placement controls the CONSOLE, not the sign-in surface)
  and is flagged as open issue 8 because ADR-0055 decision 9's "every operator control absent"
  reads as though it should cover sign-in too.
- `no_secret_in_logs.rs` — needs a second canary alongside `DATABASE_URL`'s: an SMTP password run
  through `request_setting`'s error and tracing paths (`admin.rs:418-431`, named in the scout) with a
  password shape a real SMTP server accepts (CLAUDE.md rule 2 — not a synthetic canary string).

---

## Dependencies

| Crate | Version resolved 2026-09-21 (`cargo add --dry-run` / real add-then-revert, this worktree) | Net new packages in `Cargo.lock` | `deps/decisions/` |
|---|---|---|---|
| `argon2` | `0.5.3` (`0.5` requested; `0.6.0` exists and is NOT what `0.5` resolves to) | 11 (`argon2`, `base64ct`, `blake2`, `block-buffer`, `cpufeatures`, `crypto-common`, `digest`, `generic-array`, `password-hash`, `rand_core`, `version_check`) | `deps/decisions/argon2.md` **already exists and is approved** (2026-08-15). `deps/decisions/00-CLOSURE.md`'s 22-crate list already names 9 of the 11 (shared with `chacha20poly1305`'s existing tree); **`version_check` is new and is not in that closure document** — it must be added to `00-CLOSURE.md`'s markers (it is `argon2`'s transitive build-time need, not chosen) before `gate-zero` passes. Confirmed by actually adding both crates in this worktree and reverting; `gate-zero` failed on exactly `version_check`, nothing else. |
| `sha1` | `0.10.7` (`default-features = false`) | 1 (`sha1` itself — `digest`/`cpufeatures` already arrive via `argon2`) | **No record exists.** New `deps/decisions/sha1.md` needed: RustCrypto, same family as the already-approved `sha2`/HMAC-SHA-256 in `crypto.rs`, no known audit either (name it, do not smooth it over, same shape as `argon2.md`'s own condition). |

**Ceiling.** Baseline measured this session: `gate-zero.sh` reports **141** today (matches the ADR's
figure, confirmed by running it, not quoted from the ADR). Adding both crates for real and re-running
gate-zero (then reverting — `Cargo.toml`/`Cargo.lock` are unchanged by this session) gives **141 + 12
= 153**, twelve of them already covered by an approval or an existing closure entry once
`version_check` is added to `00-CLOSURE.md`. Well inside the 200 ceiling ADR-0055 names, and inside
the "revisit at 180" line too.

**No SMTP client dependency chosen in this phase** (ADR's own cost list): `smtp` values are stored
and test-send is explicitly OUT of stream (c)'s scope per the ADR's "no SMTP client in this phase"
line — the routes table above should be read as writing and reading the SETTING; an actual outbound
connection is stream 5's work (cost/order item 5), not this contracts document's.

---

## Migration test result

Run against a live PostgreSQL, per the recipe, this session:

```
FATHOM_MIGRATE_DATABASE_URL=postgres://fathom_test@127.0.0.1:5432/fathom_p1 \
SUPERUSER_DATABASE_URL=postgres://postgres@127.0.0.1:5432/fathom_p1 \
cargo test -p fathom-server --locked --test migrate_gate
```
```
running 2 tests
test an_edited_migration_is_refused_and_an_unedited_one_applies_nothing ... ok
test verify_current_reflects_the_bookkeeping_from_the_runtime_role_alone ... ok
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```
and the in-crate unit suite:
```
cargo test -p fathom-server --locked --lib migrate::
test migrate::tests::the_first_migration_is_the_migrations_table ... ok
test migrate::tests::versions_are_unique_and_ascending ... ok
test migrate::tests::the_checksum_notices_an_edit ... ok
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 176 filtered out
```
Both runs applied all twenty migrations (1 through 20) to a fresh database. `cargo fmt --all` run
clean over the touched files. The test database (`fathom_p1`) was dropped afterward; no
`fathom_isolated_*` databases were left behind.

**Not run this session** (explicitly out of scope per the task): `cargo clippy`, the full
`cargo test --workspace`, `gate-zero.sh`/`gate-npm.sh` against a real (non-reverted) dependency
change, `no_key_protected_data.rs`, `no_secret_in_logs.rs`, `admin_exposure.rs`, `planes.rs`, or any
client/TypeScript test — none of these streams' Rust or TypeScript application code exists yet, only
schema.

---

## Open issues, numbered for pickup

1. What an `A0T` session may authorise (design/vault access) is undecided.
2. Common-password list: source, licence, size, and whether it is a crate or a vendored file.
3. Backup-code rendering form for the client (reuse the 64-hex-character convention or not).
4. Whether `/enrolment/operator/setup` returns a session directly or requires a second sign-in.
5. Whether adding a second operator (decision 3/5) collects an address at request time or at that
   operator's own first sign-in.
6. Where the seven-day "recovered" banner state lives.
7. CSP/HSTS exact directive values — must be looked up at build time, per CLAUDE.md rule 1.
8. `admin_exposure::covers()` does not gate `/session`/`/session/challenge` for `kind='operator'` on
   any host; placement (stream c) does not close this, and decision 9's text reads as though it
   should.
