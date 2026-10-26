# `rustls` — recorded 2026-10-26

| | |
|---|---|
| **Job** | TLS for the server's one outbound client: HTTPS to a person's own Vaultwarden (`src/vault_outside/https.rs`, ADR-0071 part four). TLS for Fathom's own address is still terminated in front of the binary |
| **Version** | `0.23.46`, `default-features = false`, features `ring`, `std`, `tls12`, `logging`. Not `aws-lc-rs` (the default provider, C and a CMake build) and not `prefer-post-quantum` |
| **Publisher** | rustls project, by repository URL (`https://github.com/rustls/rustls`); the publisher caveat in `00-CLOSURE-SERVER.md` applies |
| **Licence** | `Apache-2.0 OR ISC OR MIT` |
| **Ships or tooling** | **Ships.** Linked into `fathom-server` only; not reachable from `fathom-wasm` |
| **`build.rs`** | Yes, and it does nothing on a stable compiler: it only sets a `read_buf` cfg on nightly (read from the fetched crate, 2026-10-26) |
| **Proc macros** | None |
| **`unsafe`** | Five uses of `unsafe` in `src` (counted 2026-10-26). C9 admits it with this reason: no pure-Rust TLS of production standing exists; the RustCrypto provider's README says "DO NOT USE THIS IN PRODUCTION" (github.com/rustcrypto/rustls-rustcrypto, read 2026-10-26) |

## Why this and not a hand-written client

Vaultwarden's API does not answer a cross-origin browser, so a person's browser cannot reach it from
Fathom's page; the request has to be the server's, and that needs TLS. Fathom's HTTP/1.1 framing
over it is ~200 lines in `https.rs` rather than hyper's client, because the job is two requests.
Certificates are verified against `webpki-roots` plus an operator CA (`FATHOM_OUTSIDE_VAULT_CA`);
there is no switch that skips verification.

## Approval

The owner approved this crate on 2026-10-26, sign-off cards r34-vault-crates and
r34-vault-crates24 (all 24 packages the outside-vault crates bring, measured and listed first).

## Advisories

**Checked 2026-10-26**: `cargo audit` (RustSec, 1,352 advisories) over the whole lockfile reported
no vulnerability, and `cargo deny --locked check` reported `advisories ok, bans ok, licenses ok,
sources ok`. Every advisory RustSec lists against rustls is patched below this pin: RUSTSEC-2024-0336, 2024-0399, 2026-0285 and **2026-0346 to 0349 (2026-10-14), patched from 0.23.46, which is why this pin and no lower**. A result, not a clean bill of health, and it goes stale immediately.
