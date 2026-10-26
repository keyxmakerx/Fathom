# `cbc` — recorded 2026-10-26

| | |
|---|---|
| **Job** | CBC mode and PKCS#7 padding for the same Bitwarden type-2 values |
| **Version** | `0.2.1`, `default-features = false`, feature `block-padding` |
| **Publisher** | RustCrypto, by repository URL (`https://github.com/RustCrypto/block-modes`); the publisher caveat applies |
| **Licence** | `MIT OR Apache-2.0` |
| **Ships or tooling** | **Ships.** Linked into `fathom-server` only; not reachable from `fathom-wasm` |
| **`build.rs`** | None |
| **Proc macros** | None |
| **`unsafe`** | None in `src` (counted 2026-10-26) |

## CBC is not Fathom's choice

Fathom's own encryption is ChaCha20-Poly1305 and stays so. CBC is here only because an outside
vault seals in it, and only for opening, after the HMAC is verified: the order is what makes
unauthenticated CBC safe to decrypt.

## Approval

The owner approved this crate on 2026-10-26, sign-off cards r34-vault-crates and
r34-vault-crates24 (all 24 packages the outside-vault crates bring, measured and listed first).

## Advisories

**Checked 2026-10-26**: `cargo audit` (RustSec, 1,352 advisories) over the whole lockfile reported
no vulnerability, and `cargo deny --locked check` reported `advisories ok, bans ok, licenses ok,
sources ok`. Nothing in RustSec against `cbc`. A result, not a clean bill of health, and it goes stale immediately.
