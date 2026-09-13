# `ecdsa` — recorded 2026-09-12

| | |
|---|---|
| **Job** | ECDSA itself: the `Signature`, `SigningKey` and `VerifyingKey` types `src/authority.rs` calls, and `Signature::normalize_s`, which is how `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §3's malleability correction is enforced. `p256` supplies the curve; this crate supplies the algorithm |
| **Version** | `0.17.0`, `default-features = false`, `features = ["algorithm", "digest"]` |
| **Publisher** | RustCrypto — by repository URL (`https://github.com/RustCrypto/signatures`); the publisher caveat in `deps/decisions/00-CLOSURE-SERVER.md` applies |
| **Licence** | Apache-2.0 OR MIT — compatible with ADR-0004 |
| **Ships or tooling** | **Ships.** Linked into `fathom-server` |
| **`build.rs`** | None — no `build.rs` in the published tree (`~/.cargo/registry/src/.../ecdsa-0.17.0/`, listed 2026-09-12) |
| **Proc macros** | None |
| **Determinism** | The ephemeral scalar is RFC 6979-derived: `signing.rs`'s `Signer`, `MultipartSigner`, `DigestSigner` and `PrehashSigner` impls all call `sign_prehashed_rfc6979`. Same key, same message, same signature — read out of the source, because `tests/authority_vectors.rs` pins one as a literal. The `Randomized*` impls, which are the non-deterministic ones, are not used anywhere in this workspace |

## Why it is named directly when `p256` already re-exports it

`p256::ecdsa::{SigningKey, VerifyingKey, Signature}` are type aliases for this crate's generics.
`src/authority.rs` calls `Signature::from_slice`, `Signature::to_bytes` and
`Signature::normalize_s` — so this workspace *chose* the crate, and `scripts/gate-zero.sh` draws
its line exactly there: a crate a manifest names always needs its own record, whatever a closure
document already covers. Naming it also pins the version this build's malleability rule is written
against, rather than inheriting whatever `p256`'s own requirement (`^0.17`) resolves to.

## The malleability correction, and where it lands in code

§3's correction at the head of the section is what this crate is here for:

> ECDSA signatures are malleable two ways at once — the `(r, s)`/`(r, −s)` pair, and non-canonical
> DER encodings of the same values — so one authority can produce several byte-distinct
> `granter_sig` values over one `grant_bytes`.

Both halves are closed in `src/authority.rs` and both need this crate's API:

1. **Fixed-size `r ‖ s`, never DER.** A signature is stored and parsed as exactly 64 bytes
   (`Signature::from_slice`), so a DER blob is refused by length and a re-encoding of the same
   scalars cannot exist. The `der` feature is **not** named in this workspace's manifest. It is
   still in the closure, because `p256 0.14.0`'s own manifest declares its `ecdsa` dependency with
   `features = ["der"]` — what this workspace decides is that none of its own code reaches for a
   DER parser, not that the code is absent from the build.
2. **Low-S enforced on every use.** `NistP256::NORMALIZE_S` is `false` (`p256-0.14.0/src/ecdsa.rs`),
   and `hazmat::verify_prehashed` only rejects a high `s` when that constant is true — so P-256
   verification accepts both halves of the malleable pair **by design**, and a verifier that wants
   one canonical encoding has to say so itself. `authority::verify_es256` refuses any signature
   that is not equal to its own `normalize_s()`. Read from the crate's source on 2026-09-12, not
   assumed: this is the kind of default that is easy to believe backwards.

## Why not first-party

`32` §15. ECDSA is the specific algorithm where hand-rolling has a public record of catastrophe —
a repeated or biased `k` discloses the private key from two signatures — and this crate's answer to
that (RFC 6979 derivation) is precisely the part nobody should be writing fresh.

## Advisories — two databases, both with working controls, 2026-09-12

Identical sweep to `deps/decisions/p256.md`, which carries the detail: `cargo audit` over RustSec
(1,243 advisories, 0 vulnerabilities, 0 warnings, 158 crates), `cargo deny --locked check` clean,
and OSV.dev's `crates.io` bulk export read version-aware with a positive control. **Nothing found
for `ecdsa` at any version.** `scripts/osv-gate.sh` itself could not run — `api.osv.dev` is refused
by this session's proxy and the gate fails closed — so re-run it where the endpoint is reachable
before merge.
