# `tracing` — approved 2026-09-03

| | |
|---|---|
| **Job** | Structured logging and spans. `49` §6 names it; **WO-11 Disagreements 2** argues it arrives *with* the skeleton rather than late in phase 1, because retrofitting structured logging means rewriting every call site |
| **Version** | `0.1.44`, **`default-features = false`**, feature `std` |
| **Publisher** | The Tokio project (`tokio-rs`). Repository `https://github.com/tokio-rs/tracing` — read from the crate's own metadata 2026-09-03; a repository URL is a proxy for a publisher, not the answer |
| **Licence** | MIT — compatible with ADR-0004, on `deny.toml`'s allow list |
| **Ships or tooling** | **Ships.** Linked into the `fathom-server` binary, never into the WASM module |
| **`build.rs`** | None in this crate, and none in `tracing-core` |
| **Proc macros** | **`tracing-attributes` IS in the closure, and this manifest did not ask for it.** See the correction below — the `attributes` feature is off in `crates/fathom-server/Cargo.toml` and cargo turns it back on anyway |
| **Determinism** | A log line is an observation of the host, not a computation below the boundary. Invariant 9 is unaffected: nothing in `fathom-layout`, `fathom-emit` or the graph takes a subscriber |

## Why not first-party

`println!` would do for a skeleton, and that is the trap. Logging is one of the things that is
easy at the start and impossible to add later: the value is in every call site already carrying
structure, and a project that starts with `println!` gets that structure by editing every line it
ever wrote. `49` §19's phase-1 list puts operational logging late; WO-11 Disagreements 2 says
that ordering is wrong and this is the concrete reason.

## THE ONE RULE THAT MATTERS HERE

**No secret ever reaches a log line, at any level, including on the error paths.** WO-11 §6 G6 is
a test, not an aspiration: `DATABASE_URL` contains a password, and the ordinary way a password
reaches a log is an error path formatting the connection string it failed to parse. The server's
configuration type therefore keeps the URL behind a wrapper whose `Debug` and `Display` refuse to
print it, so the mistake has to be made deliberately rather than by writing `{:?}`.

This is the same shape as invariant 3 on the client: the protection is *not having the value
where the mistake would print it*.

## CORRECTION, 2026-09-03: a feature turned off here is turned back on by a sibling

**Recorded rather than quietly fixed, because it is the more useful finding.** This record was
written saying `attributes` — the feature that brings `tracing-attributes`, a proc-macro crate,
for `#[instrument]` — is "deliberately OFF", and the manifest does say
`default-features = false, features = ["std"]`. **That statement was false in effect within one
commit.**

`deadpool-postgres 0.14.2` declares `tracing = "0.1.37"` **without** `default-features = false`,
and `tracing`'s defaults are `["std", "attributes"]`. Cargo unifies features across the graph, so
`attributes` is on, `tracing-attributes` is in the closure, and it brings `syn 2.0.119` beside the
`syn 3.0.4` that `async-trait` and `tokio-macros` use. That duplicate is why `deny.toml` carries
two `[[bans.skip]]` entries with this explanation attached.

**The general lesson, which outlives this crate:** a feature disabled in *your* manifest is a
request, not a guarantee. It holds only while no other crate in the graph asks for it. Any claim
of the form *"we do not compile X"* has to be checked against the resolved graph — `cargo tree`
— and not against the manifest that asked. `00-CLOSURE.md`'s `default-features = false` argument
for the crypto crates is safe from this only because nothing else in that graph depends on them.

Neither copy of `syn` is linked into the binary; both are build-time. The cost is compile time and
two more crates to keep an eye on, not shipped code.

## Advisories

Checked against a fresh `RustSec/advisory-db` clone on **2026-09-03**.

| Advisory | Patched | In use |
|---|---|---|
| RUSTSEC-2023-0078 | ≥ 0.1.40 | 0.1.44 |

Potential stack use-after-free in `Instrumented::into_inner`, marked *unsound*. Patched far below
the pin. `tracing-core 0.1.36` carries none.

## The version, re-read

`49` §6's table was read 2026-08-21; re-read from the crates.io sparse index on **2026-09-03**:
`0.1.44` is the latest live version, unmoved. **`0.1.42` is YANKED** and is not in use — worth
recording because `deny.toml` sets `yanked = "deny"`, so if resolution ever landed on it the
build would fail rather than proceed.
