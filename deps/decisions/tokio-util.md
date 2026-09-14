# `tokio-util` — recorded 2026-09-14

**Owner-approved 2026-09-14**, on the question as put: stream a staged firmware image to a device, or
hold a two-gibibyte file in memory to answer one unauthenticated request. Approved for the first.

| | |
|---|---|
| **Job** | Exactly one item: `io::ReaderStream`, which turns an open file into the stream `axum::body::Body::from_stream` accepts, so `GET /firmware/fetch/{token}` serves a staged image a chunk at a time (ADR-0045 §4.2) |
| **Version** | `0.7`, resolving to `0.7.19`, `default-features = false, features = ["io"]` |
| **Publisher** | The Tokio project — `authors = ["Tokio Contributors <team@tokio.rs>"]`, `repository = https://github.com/tokio-rs/tokio`. Same publisher as `tokio` itself, which `deps/decisions/tokio.md` already records |
| **Licence** | MIT — compatible with ADR-0004 |
| **Ships or tooling** | **Ships.** Linked into `fathom-server` |
| **`build.rs`** | None. `build = false` in its own manifest, and no `build.rs` in the package |
| **Proc macros** | None |
| **Determinism** | Deterministic in the sense that matters: the bytes out are the bytes of the file, in order. No clock, no RNG, no ambient input |
| **`unsafe`** | **Present** — 31 occurrences across the crate. Not forbidden, unlike the RustCrypto crates recorded here. See below |

## It adds nothing to the closure, and that is checkable

`tokio-util 0.7.19` was **already in `Cargo.lock`**, arriving under `tokio-postgres`. Naming it
directly changes which manifest mentions it and nothing about what is compiled into the binary.
Measured on 2026-09-14, before and after the change:

```
gate-zero: OK  141 external package(s) in Cargo.lock
```

The package list was diffed line by line and is identical. The `io` feature's own requirements —
`bytes`, `futures-core`, `pin-project-lite` — are all already present for the same reason.

This is the difference between *admitting new code* and *admitting a new name*, and the gate makes
that distinction deliberately: `scripts/gate-zero.sh` refuses a crate a manifest names even when the
lockfile already carries it, because the project chose it and a choice needs a record. That refusal
is what produced this file.

## Why not first-party

`ReaderStream` is a small adapter and writing one is not hard. Two reasons not to.

The first is that the trait it must implement, `futures_core::Stream`, is not nameable from this
workspace without taking a direct dependency on `futures-core` — so hand-writing the adapter costs
the same approval as this record and buys a hand-maintained version of a widely-reviewed one.

The second is that this is `unsafe`-adjacent territory. A stream over an `AsyncRead` involves pinning
and a buffer whose initialisation state the compiler cannot check. `tokio-util` does that work behind
`pin-project-lite`, under the same maintainers as the runtime it pins against. A first-party version
would be our own `unsafe`, reviewed by nobody.

## The `unsafe`, stated rather than glossed

The crates recorded here for cryptography carry `unsafe_code = "forbid"`. This one does not, and
pretending otherwise would be the failure ADR-0034 exists to prevent. It is a low-level I/O and
codec library; buffer handling of that kind is where `unsafe` lives in Rust.

What limits the exposure is the feature set, not the crate: `default-features = false` with only
`io` leaves out the codec, time, sync and compat halves entirely, and `io = []` has no dependencies
of its own. The surface actually used is one type.

## What it replaces, and the thing it fixes

Without it, `firmware.rs` read a whole image into memory to answer a fetch, guarded by a process-wide
budget permitting one fetch at a time. On a route with **no session behind it** — the URL is the
credential, because a switch cannot sign a request — that is a denial-of-service surface: the worst
case was one `FATHOM_FIRMWARE_MAX_BYTES` allocation, two gibibytes by default, and a second device
was refused while it lasted.

The builder that wrote the buffered version stopped at exactly this point and reported it rather than
adding the dependency itself, which is the process working.

## Advisories

**Checked 2026-09-14**: `./scripts/gate-zero.sh`, `./scripts/lockfile-lookalikes.sh` and
`cargo metadata --locked --offline` all pass with the dependency in place and no package added.
`cargo-deny` and `cargo-audit` run in CI over the same lockfile this change does not alter — and
because it adds no package, there is no new advisory surface to sweep. A result, not a clean bill of
health, and it goes stale immediately.

**`scripts/osv-gate.sh` could not be run here**: `api.osv.dev` is refused by this environment's
proxy and the gate fails closed by design. CI runs it.
