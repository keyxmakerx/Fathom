# `sha2` — recorded 2026-09-12

| | |
|---|---|
| **Job** | The hash under the MAC and the KDF: HMAC-**SHA-256** for every seal (`docs/PHASE-2-STORAGE-DESIGN.md` §12.1), HKDF-**SHA-256** for the chain subkeys (§12.2), and the one plain digest in the tree — the chain's genesis value (§11.2) |
| **Version** | `0.11.0`, `default-features = false` |
| **Publisher** | RustCrypto — by repository URL (`https://github.com/RustCrypto/hashes`); the publisher caveat in `deps/decisions/00-CLOSURE-SERVER.md` applies |
| **Licence** | MIT OR Apache-2.0 — compatible with ADR-0004 |
| **Ships or tooling** | **Ships.** Linked into `fathom-server` |
| **`build.rs`** | None (`build = false` in its own manifest) |
| **Proc macros** | None |
| **Determinism** | A hash function: the same bytes give the same digest, on every platform. The x86 SHA-NI backend is a different instruction sequence for the identical function, not a different result |

## Already in the lockfile

Like `hmac`, `sha2` arrives with the PostgreSQL driver's SCRAM-SHA-256 support and is named
directly for the first time here. **No crate, no build script, no C and no assembly** is added by
naming it; `scripts/gate-zero.sh` asks for this file because Fathom now *chose* it.

## Why not first-party

`32` §15. A hash is the one primitive that looks most like a weekend project and is most load-
bearing when wrong: every seal, every binding and every key id in this system is a call into it.

## Why SHA-256 rather than BLAKE3 or SHA-3

It is what §12.1 settled, and the reasons are recorded there: HMAC-SHA-256 is in NIST's validated
algorithm set (ACVP), it costs zero new crates because the driver already brings it, and the
alternatives bought nothing the chain needs. **The standards texts themselves were not read** — the
proxy blocked NIST and the IETF on 2026-09-12, so FIPS 180-4 and FIPS 198-1 are cited second-hand
in that section and are listed in §12.7 as unestablished.

## Advisories

**Checked 2026-09-12 against a working control**: `cargo audit` (RustSec, 1,243 advisories) over
the whole lockfile — 0 vulnerabilities, 0 warnings, 140 crates — and `cargo deny --locked check`
reported `advisories ok, bans ok, licenses ok, sources ok`. A result, not a clean bill of health.
