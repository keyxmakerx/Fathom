# `webpki-roots` — recorded 2026-10-26

| | |
|---|---|
| **Job** | Mozilla's root certificates, compiled in, so the outside-vault client's trust does not depend on the container's CA bundle |
| **Version** | `1.0.10`, the first release that drops `emSign ECC Root CA - G3` (RUSTSEC-2026-0381, 2026-10-19). Admitted inside the cooldown window for that advisory (`00-COOLDOWN-EXCEPTIONS.md`); 1.0.11 is newer still and was not taken |
| **Publisher** | rustls project, by repository URL (`https://github.com/rustls/webpki-roots`); the publisher caveat applies |
| **Licence** | `CDLA-Permissive-2.0`, a permissive licence for data. **Not on `deny.toml`'s allow list; allowed by name for this crate only** (`[licenses] exceptions`), approved with the crates |
| **Ships or tooling** | **Ships.** Linked into `fathom-server` only; not reachable from `fathom-wasm` |
| **`build.rs`** | None |
| **Proc macros** | None |
| **`unsafe`** | None in `src` (counted 2026-10-26) |

## What it means for an operator

A vault behind a public certificate works with nothing configured. A vault on a home network with
a private CA needs `FATHOM_OUTSIDE_VAULT_CA` naming a PEM file (`docs/OPERATING.md`). Root
changes arrive only with a reviewed version bump of this crate.

## Approval

The owner approved this crate on 2026-10-26, sign-off cards r34-vault-crates and
r34-vault-crates24 (all 24 packages the outside-vault crates bring, measured and listed first).

## Advisories

**Checked 2026-10-26**: `cargo audit` (RustSec, 1,352 advisories) over the whole lockfile reported
no vulnerability, and `cargo deny --locked check` reported `advisories ok, bans ok, licenses ok,
sources ok`. RUSTSEC-2026-0381 is patched from 1.0.10, this pin. A result, not a clean bill of health, and it goes stale immediately.
