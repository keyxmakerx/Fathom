# `lettre` — recorded 2026-11-14

| | |
|---|---|
| **Job** | The SMTP client: talks to the operator's relay for every mail Fathom sends (ADR-0085 decision 9) |
| **Version** | `0.11.23`, `default-features = false`, features `smtp-transport`, `tokio1-rustls`, `ring`, `webpki-roots` |
| **Publisher** | the lettre project, by repository URL (`https://github.com/lettre/lettre`); the publisher caveat applies |
| **Licence** | `MIT` |
| **Ships or tooling** | **Ships.** Linked into `fathom-server` only; not reachable from `fathom-wasm` |
| **`build.rs`** | None |
| **Proc macros** | None |
| **`unsafe`** | None: `src/lib.rs` carries `#![forbid(unsafe_code)]` (read 2026-11-14) |

## What is turned off, and why

- **`native-tls`, `boring-tls`**: TLS goes through the rustls, ring provider and Mozilla roots
  already here (`rustls.md`, `ring.md`, `webpki-roots.md`). No OpenSSL, which `deny.toml` bans.
- **`builder`**: Fathom writes its own message (`src/mail/message.rs`, tested) and hands lettre
  the bytes with `send_raw`. Leaving it off saves five crates.
- **`pool`, `hostname`, `sendmail-transport`, `file-transport`, `dkim`**: not used.

`src/mail/smtp.rs` keeps Fathom's own rules on top: STARTTLS is required whenever TLS is asked
for (lettre's `Tls::Required`, which fails rather than sends in the clear), `none` only to a
loopback relay, a password only over TLS or to loopback, and the relay's own reply returned to
the caller with nothing it says about a password echoed.

## Why not first-party

A first-party client was built first and is on Sign-offs card r141 as the alternative. The owner
picked lettre (B) on 2026-11-14. It is the widely used Rust SMTP client, and ADR-0085 decision 9
named it on 2 November.

## What it brings

31 transitive packages, listed with their licences and dates in `00-CLOSURE-MAIL.md`. Most are
`url` and `idna` and the ICU4X Unicode tables under `idna` (`icu_*`, `zerovec`, `yoke` and
friends, Unicode-3.0). The card said 34 for lettre with its message builder; without the builder
it is 31 plus lettre, 32 in all. `base64` arrives a second time (0.23.1, beside 0.22.1 under
`postgres-protocol`), named in `deny.toml`'s `[[bans.skip]]`.

## Approval

The owner approved this crate on 2026-11-14, Sign-offs card r141-mail-built, question "How Fathom
talks to the mail server", answer B ("Switch to lettre ... it brings 34 new libraries ... Each
needs your approval under the dependency rule"), and pressed Approve on the card.

## Advisories

**Checked 2026-11-14** on rustsec.org/packages/lettre.html. Three, none reaching 0.11.23 as used:

- **RUSTSEC-2026-0141** (critical): hostname checking off under the `boring-tls` backend, 0.10.1
  to 0.11.21, patched in 0.11.22. The advisory says `rustls` and `native-tls` are unaffected; this
  build uses rustls and leaves `boring-tls` off.
- **RUSTSEC-2021-0069**: SMTP command injection through the body's dot-escaping, patched in
  0.10.0-rc.3.
- **RUSTSEC-2020-0069**: argument injection in the sendmail transport, which is off here.

`scripts/osv-gate.sh` could not reach api.osv.dev from the build session (proxy 403); CI runs it
and `cargo deny`. A result, not a clean bill of health, and it goes stale immediately.
