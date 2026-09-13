# `chacha20poly1305` — approved 2026-08-15, version corrected 2026-09-12

| | |
|---|---|
| **Job** | The AEAD. It seals a workspace file, and since 2026-09-12 every design payload and every wrapped data key on the server. `32` D3 chose ChaCha20-Poly1305 (RFC 8439) over AES-256-GCM because WASM has no AES instructions, so the acceleration argument only pays via WebCrypto, which means moving plaintext into the JS heap |
| **Version** | `0.11.0`, `default-features = false`, with `alloc` and `zeroize` — **corrected from `0.10` on 2026-09-12, see below** |
| **Publisher** | RustCrypto |
| **Licence** | Apache-2.0 OR MIT — compatible with ADR-0004 |
| **Ships or tooling** | **Ships.** Linked into `fathom-wasm`, and since 2026-09-12 into `fathom-server` as well — it is the AEAD for every design payload and every wrapped key (`docs/PHASE-2-STORAGE-DESIGN.md` §4) |
| **`build.rs`** | None in this crate |
| **Proc macros** | None |
| **Determinism** | Deterministic by construction: same key, nonce and plaintext give the same ciphertext. No clock, no RNG, no `HashMap`. Satisfies invariant 9 provided the caller supplies the nonce, which the host frame does |

## Why not first-party

**Because writing it ourselves would be the least defensible thing in the tree.** `32` §15 forbids
hand-rolling, and it is right: a from-scratch AEAD in a zero-dependency crate, authored by a model,
protecting a network engineer's firewall topology, would be the single weakest component in a
project whose entire claim is that you can trust what it does. Twenty-two audited-adjacent crates
from the Rust cryptography community is a strictly better trade than one unaudited file of ours.

## Audit

**One security audit by NCC Group, no significant findings, funded by MobileCoin.** Stated in the
crate's own README (`RustCrypto/AEADs`, read 2026-08-15). NCC Group's public report is *"RustCrypto
AES/GCM and ChaCha20+Poly1305 Implementation Review"*, engagement December 2019.

Constant time, per the same README: *"designed to execute in constant time, either by relying on
hardware intrinsics (i.e. AVX2 on x86/x86_64), or using a portable implementation which is only
constant time on processors which implement constant-time multiplication."* It records one
exclusion — processors with variable-time multiply, naming certain 32-bit PowerPC CPUs and some
non-ARM microcontrollers. **Not a concern for this product**, whose targets are wasm32 in a
browser and x86-64/aarch64 natively.

## The version was wrong, and 0.10 would have failed the build

Recorded 2026-09-12, from `docs/PHASE-2-STORAGE-DESIGN.md` §12.4 and verified against
`Cargo.lock`: **`chacha20poly1305 0.10.1` wants `chacha20 ^0.9`**, and this lockfile already
carries `chacha20 0.10.2` — it arrives through `rand` ← `postgres-protocol` ← the PostgreSQL
driver. `deny.toml` sets `multiple-versions = "deny"`, so pinning 0.10 would have put two
`chacha20` majors in the graph and failed the dependency gate. **0.11.0 unifies with what is
already there.**

Two consequences worth writing down rather than rediscovering:

* The version in this record was decided on 2026-08-15 against a workspace with **no server and no
  PostgreSQL driver**. It was correct then and wrong by the time it was used, which is the ordinary
  fate of a pinned version recorded beside a growing lockfile.
* **`cipher 0.5.0` is yanked** and `deny.toml` sets `yanked = "deny"`. The lock resolves to
  `cipher 0.5.2` — checked in the lockfile diff on 2026-09-12 rather than assumed, and
  `cargo deny --locked check` agrees.

`zeroize` is **on**, per §12.4's table: it is what clears the expanded ChaCha state and the key
held inside the cipher on drop. `getrandom` (the AEAD's own feature) is **off**: nonces are drawn
through the `getrandom` crate directly, at one place in `src/crypto.rs`, so that there is exactly
one line in this server that produces a nonce.

## Advisories

Zero, open or historic, against this crate. Checked against a fresh `RustSec/advisory-db` clone
2026-08-15.

**Re-checked 2026-09-12 for the 0.11.0 arrival**: `cargo audit` (RustSec, 1,243 advisories) over
the whole lockfile reported 0 vulnerabilities and 0 warnings across 140 crates, and
`cargo deny --locked check` reported `advisories ok, bans ok, licenses ok, sources ok`. ADR-0043
§11 asked for exactly this re-check, because the session that wrote that ADR could not reach an
advisory service at all. A result, not a clean bill of health.
