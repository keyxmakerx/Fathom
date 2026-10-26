# `tokio-rustls` — recorded 2026-10-26

| | |
|---|---|
| **Job** | Runs `rustls` over a tokio TCP stream for the outside-vault client |
| **Version** | `0.26.6`, `default-features = false`, feature `ring` |
| **Publisher** | rustls project, by repository URL (`https://github.com/rustls/tokio-rustls`); the publisher caveat applies |
| **Licence** | `MIT OR Apache-2.0` |
| **Ships or tooling** | **Ships.** Linked into `fathom-server` only; not reachable from `fathom-wasm` |
| **`build.rs`** | None |
| **Proc macros** | None |
| **`unsafe`** | None in `src` (counted 2026-10-26) |

## Why not first-party

Driving a rustls `ClientConnection` over an async socket by hand is the glue that is easy to get
subtly wrong (short reads, close_notify, write flushing). It brings no package of its own beyond
rustls and tokio, which are already here.

## Approval

The owner approved this crate on 2026-10-26, sign-off cards r34-vault-crates and
r34-vault-crates24 (all 24 packages the outside-vault crates bring, measured and listed first).

## Advisories

**Checked 2026-10-26**: `cargo audit` (RustSec, 1,352 advisories) over the whole lockfile reported
no vulnerability, and `cargo deny --locked check` reported `advisories ok, bans ok, licenses ok,
sources ok`. RustSec lists one historic advisory (excessive memory on reads), patched long before 0.26. A result, not a clean bill of health, and it goes stale immediately.
