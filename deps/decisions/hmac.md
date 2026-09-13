# `hmac` — recorded 2026-09-12

| | |
|---|---|
| **Job** | The chain MAC. `docs/PHASE-2-STORAGE-DESIGN.md` §12.1 chose HMAC-SHA-256 for every seal and binding in the tamper-evident history (§11.2) and for the non-secret key id ADR-0043 §4 requires |
| **Version** | `0.13.0`, `default-features = false` |
| **Publisher** | RustCrypto — by repository URL (`https://github.com/RustCrypto/MACs`). `deps/decisions/00-CLOSURE-SERVER.md`'s caveat applies verbatim: a repository URL is written by the crate's author and proves nothing about who holds the publish token |
| **Licence** | MIT OR Apache-2.0 — compatible with ADR-0004 |
| **Ships or tooling** | **Ships.** Linked into `fathom-server` |
| **`build.rs`** | None (`build = false` in its own manifest) |
| **Proc macros** | None |
| **Determinism** | Deterministic by construction: same key and message give the same tag. No clock, no RNG, no `HashMap` |

## It was already in the lockfile, and that is not a reason to skip this record

`hmac` arrives with SCRAM-SHA-256 authentication in the PostgreSQL driver —
`hmac → postgres-protocol → postgres-types → tokio-postgres → deadpool-postgres → fathom-server`,
the path `docs/PHASE-2-STORAGE-DESIGN.md` §12.1 verified. So naming it in
`crates/fathom-server/Cargo.toml` adds **no crate, no build script, no C and no assembly** to the
closure.

`scripts/gate-zero.sh` still demands this file, and rightly: *"a crate this workspace NAMES in a
manifest always needs its own record, because Fathom chose it."* The distinction the gate draws is
between a crate that arrived and a crate that was chosen, and this is now the second kind.

## Why not first-party

`32` §15 forbids hand-rolling cryptography, and a MAC is exactly where that rule earns its keep.
The construction is simple enough to look easy and unforgiving enough that a mistake is silent:
a truncated comparison, a variable-time comparison, or a key-length edge case produces a MAC that
verifies everything an attacker sends and nothing tells you.

## Constant-time comparison, read rather than assumed

§12.1 records the reading: `digest 0.11.3`'s `Mac` trait compares tags through `ctutils::CtEq`,
and `src/crypto.rs` uses `Mac::verify_slice` — never `==` on two byte slices — so verification
inherits that path. **`cmov` is on that path** (`digest` → `ctutils::CtEq` → `cmov`), which makes
CVE-2026-50185 / GHSA-3rjw-m598-pq24 (2026-07-02, wrong results on aarch64 with high register bits
set, fixed in 0.5.4) relevant to this crate's behaviour rather than to somebody else's. `Cargo.lock`
pins `cmov 0.5.4`, verified on 2026-09-12 — **and RustSec does not carry that advisory**, so
`cargo audit` would not have raised it. §12.5 is the fuller note.

## Poly1305 is not an alternative here

RustCrypto's own source, quoted in §11.2: *"Poly1305 is not a traditional MAC and is single-use
only (a.k.a. 'one-time authenticator')."* It is sound inside ChaCha20-Poly1305, where the AEAD
gives it a fresh one-time key per message. Lifting it out and keying it repeatedly breaks it. KMAC
was the other candidate and **does not exist in Rust** — RustCrypto ships none and the `kmac` name
on crates.io is an empty placeholder — and keyed BLAKE2 would have cost a crate for no property
this needs. HMAC-SHA-256 is also in NIST's validated algorithm set (ACVP lists `HMAC-SHA2-256`).

## Advisories

**Checked 2026-09-12 against a working control**: `cargo audit` (RustSec, 1,243 advisories loaded)
over the whole lockfile reported 0 vulnerabilities and 0 warnings across 140 crates, and
`cargo deny --locked check` reported `advisories ok, bans ok, licenses ok, sources ok`. That is a
result, not a clean bill of health, and it goes stale immediately — re-run before merge.
