# `tracing` — approved 2026-09-03

| | |
|---|---|
| **Job** | Structured logging and spans. `49` §6 names it; **WO-11 Disagreements 2** argues it arrives *with* the skeleton rather than late in phase 1, because retrofitting structured logging means rewriting every call site |
| **Version** | `0.1.44`, **`default-features = false`**, feature `std` |
| **Publisher** | The Tokio project (`tokio-rs`). Repository `https://github.com/tokio-rs/tracing` — read from the crate's own metadata 2026-09-03; a repository URL is a proxy for a publisher, not the answer |
| **Licence** | MIT — compatible with ADR-0004, on `deny.toml`'s allow list |
| **Ships or tooling** | **Ships.** Linked into the `fathom-server` binary, never into the WASM module |
| **`build.rs`** | None in this crate, and none in `tracing-core` |
| **Proc macros** | **None enabled.** `attributes` — the feature that brings `tracing-attributes`, a proc-macro crate, for `#[instrument]` — is deliberately OFF. Spans opened by hand cost a line each and cost no compile-time code execution |
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
