# `chacha20poly1305` — approved 2026-08-15

| | |
|---|---|
| **Job** | The AEAD that seals a workspace file. `32` D3 chose ChaCha20-Poly1305 (RFC 8439) over AES-256-GCM because WASM has no AES instructions, so the acceleration argument only pays via WebCrypto, which means moving plaintext into the JS heap |
| **Version** | `0.10`, `default-features = false` |
| **Publisher** | RustCrypto |
| **Licence** | Apache-2.0 OR MIT — compatible with ADR-0004 |
| **Ships or tooling** | **Ships.** Linked into `fathom-wasm` |
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

## Advisories

Zero, open or historic, against this crate. Checked against a fresh `RustSec/advisory-db` clone
2026-08-15.
