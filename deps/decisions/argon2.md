# `argon2` — approved 2026-08-15, **with a condition**

| | |
|---|---|
| **Job** | Turns a passphrase into a key. `32` D1 chose Argon2id v1.3 (RFC 9106) over scrypt (weaker side-channel story, no `id` mode) and PBKDF2 (memory-free, GPU-friendly) |
| **Version** | `0.5`, `default-features = false` |
| **Publisher** | RustCrypto |
| **Licence** | Apache-2.0 OR MIT — compatible with ADR-0004 |
| **Ships or tooling** | **Ships.** Linked into `fathom-wasm` |
| **`build.rs`** | None in this crate |
| **Proc macros** | None |
| **Determinism** | Deterministic: same password, salt and parameters give the same output. Takes its salt from the caller, so it reads no RNG. Satisfies invariant 9 |

## THE CONDITION, AND WHY THIS RECORD IS NOT LIKE ITS NEIGHBOUR

**This crate has no security audit.** Its README (`RustCrypto/password-hashes`, read 2026-08-15)
contains no audit section, no production caveat, and no statement of which RFC revision it
implements. That is a genuine difference from `chacha20poly1305`, which is audited, and it is
recorded here rather than smoothed over.

**Condition of approval: the implementation is pinned against RFC 9106's published test vectors,
and that test is part of the verification floor.** An unaudited implementation of a *specified*
algorithm is a much smaller risk than an unaudited implementation of an unspecified one, because
the specification comes with known-answer tests. If this crate computes Argon2id incorrectly, the
vector test says so on every CI run. It does not catch a side-channel, and this record does not
claim it does.

## Why the risk is acceptable anyway

What a KDF defect would cost here is bounded, and worth stating plainly:

- **It is not the confidentiality boundary.** The AEAD is. A KDF flaw that weakened key derivation
  would make an *offline* attack on a stolen file cheaper; it would not reveal a workspace to
  someone who does not have the file.
- **The realistic attacker already needs the file.** For the current single-user local deployment
  that means access to the operator's own disk, at which point the estate is one of many things
  they have.
- **The alternative is worse.** The only Rust alternatives are a hand-rolled Argon2 (refused above,
  and by `32` §15) or a weaker KDF. `32` D1 already rejected scrypt and PBKDF2 on the merits.

## Parameters

`32` D1 sets a floor of `m=64 MiB, t=3, p=1` for the client-side file key. **That floor is for a
file key derived once on open, not for a server-side login hash** — those have different latency
budgets and should not share a number. No server exists yet; when one does, its parameters get
their own decision rather than inheriting this one.

## Advisories

Zero, open or historic. Checked against a fresh `RustSec/advisory-db` clone 2026-08-15.
