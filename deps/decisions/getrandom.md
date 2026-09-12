# `getrandom` — recorded 2026-09-12

| | |
|---|---|
| **Job** | The CSPRNG. Every nonce and every data key in `src/crypto.rs` comes from `getrandom::fill`, which is the operating system's generator and nothing else (`docs/PHASE-2-STORAGE-DESIGN.md` §12.4) |
| **Version** | `0.4.3`, `default-features = false` |
| **Publisher** | rust-random — by repository URL (`https://github.com/rust-random/getrandom`); the publisher caveat in `deps/decisions/00-CLOSURE-SERVER.md` applies |
| **Licence** | MIT OR Apache-2.0 — compatible with ADR-0004 |
| **Ships or tooling** | **Ships.** Linked into `fathom-server` |
| **`build.rs`** | **YES — and it was read, because that is the column the August 2026 attack was about.** See below |
| **Proc macros** | None |
| **Determinism** | **Deliberately not deterministic**, and it is the one place in this server where that is the requirement rather than a defect. Invariant 9 governs emitted artifacts; a nonce is not one |

## `build.rs`, read in full on 2026-09-12

Ten lines, from the fetched source tree under `~/.cargo/registry/src`:

```rust
//! Build script for memory sanitization support
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let sanitizers = std::env::var("CARGO_CFG_SANITIZE").unwrap_or_default();
    if sanitizers.contains("memory") {
        println!("cargo:rustc-cfg=getrandom_msan");
    }
}
```

It reads one Cargo-supplied environment variable and emits one `cfg`. **No network, no download, no
file written, no code generated, no other process run** — which is the specific shape
RUSTSEC-2026-0260 (`proc-macro1`, 2026-08-20) had and this does not. Recorded because "has a build
script" is a fact this project reports rather than a verdict it passes.

## Why the OS generator and not `rand`

§12.4, in one line: **no userspace generator state and no reseeding path**, which is the surface
the 2026 `rand` advisory concerns. `rand` is in this lockfile anyway — the PostgreSQL driver pulls
it — and that is precisely why this record matters: the nonce path must not quietly become the one
through a userspace generator because it was already there.

`getrandom::fill` returns a `Result`, and `src/crypto.rs` **propagates the error rather than
falling back to anything**. `CryptoError::NoRandomness` is the whole handling: nothing is written,
and no second-choice generator exists. A nonce from a degraded source is how two messages end up
under one (key, nonce) pair, which leaks the XOR of the plaintexts *and* the Poly1305 one-time key
(§12.3) — so a fallback would be strictly worse than a refusal.

## Why not first-party

`src/ids.rs` reads `/dev/urandom` directly for ULIDs and says why: those ids are primary keys, not
secrets. Key material is the other case. A hand-rolled reader would have to get the retry-on-EINTR,
the short-read and the early-boot-entropy cases right on every supported platform, and the failure
mode of getting them wrong is silent.

## Advisories

**Checked 2026-09-12 against a working control**: `cargo audit` (RustSec, 1,243 advisories) over
the whole lockfile — 0 vulnerabilities, 0 warnings, 140 crates — and `cargo deny --locked check`
reported `advisories ok, bans ok, licenses ok, sources ok`. A result, not a clean bill of health.
