# `sha1` — proposed 2026-09-21 by ADR-0055 stream (a). **Awaiting the owner's approval.**

| | |
|---|---|
| **Job** | The HMAC inside an RFC 6238 TOTP code, and nothing else in this server. ADR-0055 decision 10: *"RFC 6238 TOTP, SHA-1, six digits, 30-second step"* |
| **Version** | `0.11`, resolved to `0.11.0`, `default-features = false`. **Not the `0.10` the build contracts measured** — see the manifest comment: `hmac 0.13`, already in this workspace, wants `digest ^0.11` and `sha1 0.10` wants `digest ^0.10`, so the pair does not compile. `cargo add --dry-run` resolves a version without compiling against it, which is how the contracts got 0.10 |
| **Publisher** | RustCrypto (`RustCrypto/hashes`), the same family as the already-approved `sha2` and `hmac` in `crates/fathom-server/Cargo.toml` |
| **Licence** | `MIT OR Apache-2.0` — read off `RustCrypto/hashes`' own `sha1/Cargo.toml` on 2026-09-21. Compatible with ADR-0004 |
| **Ships or tooling** | **Ships.** Linked into `fathom-server`. **Not** reachable from `fathom-wasm` — `crates/fathom-server/Cargo.toml` is the only manifest that names it, and `fathom-wasm/tests/artifact_gates.rs`'s empty import allowlist is what keeps that true |
| **`build.rs`** | None in this crate. `cpufeatures 0.3.1`, which it pulls on x86/x86-64/aarch64, has one and is already in `Cargo.lock` through `sha2` |
| **Proc macros** | None |
| **Determinism** | Deterministic: FIPS 180-4's function, byte-for-byte, with no RNG and no clock |
| **Net new packages in `Cargo.lock`** | **One**: `sha1` itself. `cfg-if`, `cpufeatures 0.3` and `digest 0.11` all arrive already through `hmac`/`sha2`, which is the other half of the reason for `0.11` over `0.10` |

## SHA-1 IS BROKEN, THE CRATE SAYS SO, AND THIS RECORD DOES NOT SMOOTH IT OVER

`RustCrypto/hashes`' own `sha1/README.md`, read 2026-09-21, opens with a heading:

> **Warning: Cryptographically Broken!**
> The SHA-1 hash function should be considered cryptographically broken and unsuitable for
> further use in any security critical capacity, as it is practically vulnerable to
> chosen-prefix collisions. We provide this crate for legacy interoperability purposes only.

**That warning is about collision resistance, and collision resistance is not the property this
use needs.** RFC 6238 §1.2 builds TOTP on HOTP (RFC 4226), whose security argument is that
`HMAC-SHA-1` is a *pseudorandom function* keyed by a shared secret. The attacker in that model
does not hold the key, cannot choose both halves of a colliding pair, and gets six digits of a
truncated tag against which the code is single-use and rate-limited. The 2017 and 2020
chosen-prefix collision results do not touch HMAC-SHA-1's PRF security; NIST SP 800-107 Rev. 1 §5.3
makes the same distinction between the hash's collision resistance and the security of HMAC built
on it. **This record states the distinction rather than asserting the crate is fine.**

**Why SHA-1 at all, then.** Because interoperability is the whole of the requirement. ADR-0055
decision 10 is that the second factor is *"an app code"* the person enrols in an ordinary
authenticator application. RFC 6238's default is SHA-1 and that is what the installed base
implements; a server that chose SHA-256 would produce `otpauth://` URIs that a real phone answers
with the wrong six digits. CLAUDE.md rule 2 — *"test a safety gate against what a real device
accepts"* — cuts in favour of the algorithm the devices accept.

**The blast radius, stated narrowly.** A defect in this crate costs a wrong six-digit comparison:
either a legitimate code is refused (the person uses a backup code) or a wrong one is accepted,
which is one factor of two, behind a password, behind the existing `sign_in_attempts` rate limits,
with replay refused by `accounts.totp_last_step`. It is not the confidentiality boundary — the AEAD
is — and it wraps no key.

**Nothing else may call it.** `crates/fathom-server/src/credentials.rs` is the only module that
names `sha1`, and `crates/fathom-server/tests/credentials.rs` asserts that by reading the crate's
own sources. If a second caller ever appears, this record is wrong and has to be rewritten.

## Audit status

**None, and that is the same gap `deps/decisions/argon2.md` names for `argon2`.** No security
audit of `RustCrypto/hashes` was found on 2026-09-21; the repository's README carries no audit
section. Named, not smoothed over, exactly as `argon2.md`'s own condition paragraph does.

**Condition of approval, proposed, the same shape `argon2.md` set**: the implementation is pinned
against RFC 4226 Appendix D's published HOTP test vectors, and that test is part of the
verification floor. The vectors live in `crates/fathom-server/src/credentials.rs`'s own test module (`hotp_matches_rfc_4226_appendix_d`, and RFC 6238 Appendix B's SHA-1 rows beside it), so they run on every `cargo test -p fathom-server --lib`. An unaudited
implementation of a *specified* algorithm is a much smaller risk than an unaudited implementation
of an unspecified one, because the specification comes with known-answer tests.

## Advisories

`cargo audit` and `deny.toml` are the two layers that answer this, run on every CI build; this
record does not quote a count it did not read off a run. Nothing is known to this session about an
open advisory against `sha1 0.11.0`.

## Why not first-party

CLAUDE.md rule 1's shape: a hand-rolled SHA-1 is a cryptographic primitive written from memory,
which is precisely what this project refuses. `deps/decisions/argon2.md` already rejected the same
move for Argon2 and the argument is unchanged.
