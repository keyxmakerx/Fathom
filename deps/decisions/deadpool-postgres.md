# `deadpool-postgres` — approved 2026-09-03

| | |
|---|---|
| **Job** | The connection pool. `49` §6 names it beside `tokio-postgres`. A server that opens a PostgreSQL connection per request pays a TCP handshake, a TLS-less startup exchange and a SCRAM authentication per request — and SCRAM is deliberately expensive, which is the point of RUSTSEC-2026-0179 |
| **Version** | `0.14.2`, **`default-features = false`**, feature `rt_tokio_1` |
| **Publisher** | `bikeshedder` / the deadpool project. Repository `https://github.com/bikeshedder/deadpool` — from the crate's own metadata 2026-09-03 |
| **Licence** | MIT OR Apache-2.0 — compatible with ADR-0004 |
| **Ships or tooling** | **Ships.** In the binary only |
| **`build.rs`** | None, in it or in `deadpool` / `deadpool-runtime` |
| **Proc macros** | `async-trait` (shared with `tokio-postgres`) |
| **Determinism** | A pool hands out whichever connection is free, so nothing may depend on *which*. Session-scoped state (`SET`, temp tables, prepared statements outside the driver's own cache) is therefore forbidden here — a later request will get a different connection |

## The version this one was NOT given

`49` §6 names `deadpool-postgres` without a version. `0.14.2` was read from the crates.io sparse
index on **2026-09-03** — the latest live version, unyanked — rather than carried over from any
document. Recorded because WO-11 §7 trigger 1 is about exactly this: a version that no one re-read
is a version no one checked.

## It re-enables a feature this workspace turned off

`deadpool-postgres` declares `tracing = "0.1.37"` **without** `default-features = false`, so
cargo's feature unification turns `tracing`'s `attributes` feature back on across the whole graph
— even though `crates/fathom-server/Cargo.toml` asks for it off. The consequence is
`tracing-attributes` in the closure and a second copy of `syn`.

The finding is recorded at length in `tracing.md` because the lesson is general: **a feature
disabled in your manifest is a request, not a guarantee.** Any claim of the form *"we do not
compile X"* must be checked against `cargo tree`, not against the manifest that asked.

## `serde` is off

`deadpool-postgres`'s `serde` feature would let a pool be configured from a deserialised struct.
It is off; the configuration here comes from environment variables read by hand. `serde` is
therefore in `Cargo.lock` (something else's optional dependency) but **not in the Linux build
graph** — verified with `cargo tree --target x86_64-unknown-linux-gnu` on 2026-09-03.

## Advisories

**Zero against `deadpool-postgres`, `deadpool` or `deadpool-runtime`**, open or historic, checked
against a fresh `RustSec/advisory-db` clone on 2026-09-03 and mechanically by `cargo audit` and
`cargo deny` on every push.

That is a real gap in the record, not a clean bill: an absence of advisories for a smaller crate
means less about its safety than the same absence for `tokio`. What it does say is that the pool
is a small amount of code — its whole job is to hold connections in a `Vec` and hand them back —
and that its own closure adds only `deadpool` and `deadpool-runtime`.
