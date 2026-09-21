# Accepted one-edit crate-name pairs

`scripts/lockfile-lookalikes.sh` fails the build when two packages in `Cargo.lock` have names
one edit apart and at least one of them came from a registry. That is the shape of the August
2026 crates.io attack — `proc-macro1` published beside the near-universal `proc-macro2`,
arriving transitively, its build script running at compile time (RUSTSEC-2026-0260,
2026-08-20).

A row here is a decision that a pair is real and understood — never a way to quieten a check.

**It was empty until 2026-09-21**, when ADR-0055 stream (a) added `sha1` beside the `sha2`
that has been in this lockfile since Phase 2's key hierarchy. That pair is one edit apart, and
it is the first real one this project has had.

Two first-party crates are never a pair: `fathom-id` and `fathom-ir` are one edit apart and
neither can be a squat of the other, because both are path members written in this repository.
The script skips that case in code rather than needing a row here.

<!-- lookalikes:accepted -->

| a | b | why the pair is real |
|---|---|---|
| `sha1` | `sha2` | **Both are RustCrypto's, both are in `RustCrypto/hashes`, and the pair is the SHA family's own naming and not a near-miss.** `sha2` (`0.11`) has been here since Phase 2's key hierarchy: it is HKDF-SHA-256's hash, HMAC-SHA-256's hash, and the digest under every seal in this server. `sha1` (`0.11`) arrived 2026-09-21 with ADR-0055 decision 10, for one job — the HMAC inside an RFC 6238 six-digit app code, which RFC 6238 §1.2 fixes as SHA-1 and which every authenticator application implements. Checked, not assumed, on 2026-09-21: both resolve to the same `repository = "https://github.com/RustCrypto/hashes"`, both carry `MIT OR Apache-2.0`, both are in the same `digest 0.11` major, and `deps/decisions/sha1.md` and `deps/decisions/sha2.md` each name their own. **Neither can be a squat of the other**: a squat is a name nobody chose, arriving transitively, and both of these are named directly in `crates/fathom-server/Cargo.toml` by a line somebody wrote a paragraph about. |

<!-- lookalikes:end -->

## How to add a row

Look at both names. If one is a squat, remove it and report it to the RustSec advisory
database and to crates.io. If the pair is genuine, name both crates above with the reason —
who publishes each, and what each does — so the next reader can check the judgement rather
than inherit it.
