# `tracing-subscriber` — approved 2026-09-03

| | |
|---|---|
| **Job** | The thing that actually writes a `tracing` event somewhere. `tracing` produces events; without a subscriber they go nowhere |
| **Version** | `0.3.23`, **`default-features = false`**, features `fmt`, `std` |
| **Publisher** | The Tokio project (`tokio-rs`), same repository as `tracing` |
| **Licence** | MIT — compatible with ADR-0004 |
| **Ships or tooling** | **Ships.** In the binary only |
| **`build.rs`** | None. Its closure adds `lazy_static`, `once_cell`, `sharded-slab` and `thread_local`, none of which carries one either |
| **Proc macros** | None |
| **Determinism** | Not applicable — see `tracing.md` |

## `ansi` is OFF, and that is a security choice with a name

**RUSTSEC-2025-0055** (2025-08-29, CVE-2025-58160, GHSA-xwfj-jgwm-7wp5): *"Logging user input may
result in poisoning logs with ANSI escape sequences."* Untrusted input logged with escape
sequences intact can manipulate a terminal — title bars, screen clearing — and the advisory notes
that terminal-emulator vulnerabilities have been reached this way. Patched at ≥ 0.3.20 by
escaping control characters, and the pin here is 0.3.23, so the fix is present.

**The feature is still off**, because the cheapest way not to emit an escape sequence is not to
compile the code that writes one. A server whose logs are read by a collector has no use for
colour. This is belt and braces on a patched crate, and it costs nothing.

## `env-filter` and `json` are off, and what turning them on costs

| feature | what it would add | when to turn it on |
|---|---|---|
| `env-filter` | `regex`, `regex-automata`, `regex-syntax`, `aho-corasick`, `memchr` — **five crates to parse a filter string** | when per-target filtering is actually wanted. The skeleton reads one level from one environment variable, which needs no regular expressions |
| `json` | `serde` and `serde_json` | the day a log collector exists to consume structured output. Those two crates then get recorded in the closure like everything else |

Recorded rather than silently omitted because both are the kind of thing a later session turns on
without noticing the cost. `35` §5.1's cap is ≤ 160 in the closure; five crates for a filter
string is 3% of the whole budget.

## Advisories

Checked against a fresh `RustSec/advisory-db` clone on **2026-09-03**.

| Advisory | Crate | Patched | In use |
|---|---|---|---|
| RUSTSEC-2025-0055 | `tracing-subscriber` | ≥ 0.3.20 | **0.3.23** |
| RUSTSEC-2019-0017 | `once_cell` | ≥ 1.0.1 | 1.21.4 |
| RUSTSEC-2022-0006 | `thread_local` | ≥ 1.1.4 | 1.1.10 |

`lazy_static`, `sharded-slab` and `tracing-core` carry none.

## The version, re-read

Re-read from the crates.io sparse index on **2026-09-03**: `0.3.23` is the latest live version,
unmoved. `0.3.21` is yanked and is not in use.
