# `aes` — recorded 2026-10-26

| | |
|---|---|
| **Job** | AES-256, the block cipher under a Bitwarden type-2 value (`src/vault_outside/bitwarden.rs`) |
| **Version** | `0.9.3`, `default-features = false` |
| **Publisher** | RustCrypto, by repository URL (`https://github.com/RustCrypto/block-ciphers`), the family of the approved `hmac` and `sha2`; the publisher caveat applies |
| **Licence** | `MIT OR Apache-2.0` |
| **Ships or tooling** | **Ships.** Linked into `fathom-server` only; not reachable from `fathom-wasm` |
| **`build.rs`** | None |
| **Proc macros** | None |
| **`unsafe`** | Yes, about sixty uses in `src` (counted 2026-10-26): the AES-NI and ARMv8 intrinsics, selected at run time by `cpufeatures`, already in the lockfile. C9 admits it: the portable fallback is constant-time bitsliced code, and the intrinsics are the reason AES here is not a table-lookup timing leak |

## Why not first-party

Bitwarden's format is fixed by Bitwarden (bitwarden/sdk-internal, read 2026-10-26: HMAC-SHA256
over iv ‖ ciphertext, then AES-256-CBC with PKCS#7). Writing AES by hand is the textbook way to
add a cache-timing leak. Fathom only ever opens these values, after the MAC verifies in constant
time, so there is no padding oracle; `seal_type2` exists for tests and stand-ins.

## Approval

The owner approved this crate on 2026-10-26, sign-off cards r34-vault-crates and
r34-vault-crates24 (all 24 packages the outside-vault crates bring, measured and listed first).

## Advisories

**Checked 2026-10-26**: `cargo audit` (RustSec, 1,352 advisories) over the whole lockfile reported
no vulnerability, and `cargo deny --locked check` reported `advisories ok, bans ok, licenses ok,
sources ok`. Nothing in RustSec against `aes`. A result, not a clean bill of health, and it goes stale immediately.
