# `tokio` — approved 2026-09-03

| | |
|---|---|
| **Job** | The async runtime. `49` §6 names it *"unavoidable and universal"*, and the reason is structural rather than fashionable: the HTTP layer (`axum`), the PostgreSQL driver (`tokio-postgres`) and the WebSocket transport the collaborative editor needs are all written against tokio's traits. Choosing a different runtime does not mean writing different glue; it means having no HTTP server and no database driver |
| **Version** | `1.53.1`, **`default-features = false`**, features `rt-multi-thread`, `net`, `macros`, `signal`, `time`, `fs` |
| **Publisher** | The Tokio project (`tokio-rs`). Repository `https://github.com/tokio-rs/tokio` — read from the crate's own metadata 2026-09-03. **Not the crates.io owner list**, which needs the JSON API; see `00-CLOSURE-SERVER.md` on what that column can and cannot say |
| **Licence** | MIT — compatible with ADR-0004, and on `deny.toml`'s allow list |
| **Ships or tooling** | **Ships.** Linked into the `fathom-server` binary. It is **not** in the WASM module and must never be: the browser side has no runtime and no sockets, which is invariant 1's whole point for the client |
| **`build.rs`** | **None in this crate.** Three crates in its closure carry one — `libc`, `proc-macro2` and `quote` — and that is where the compile-time risk actually sits; `00-CLOSURE-SERVER.md` has the measurement |
| **Proc macros** | `tokio-macros` (its `macros` feature) is a proc-macro crate and runs at compile time. It is in the closure with that status recorded |
| **Determinism** | **Not deterministic, and it does not have to be.** Invariant 9 governs code below the host boundary — the module that turns a graph into a picture. A server's task scheduler is the host boundary. What must stay deterministic is what the server *computes*: the same graph must produce the same layout and the same export whatever order the tasks ran in, and that is a property of `fathom-layout` and `fathom-emit`, which take no runtime |

## Why not first-party

An async runtime is a work-stealing scheduler, an epoll/kqueue/IOCP reactor, a timer wheel and a
set of synchronisation primitives whose correctness is a memory-model argument. Writing one is not
a smaller job than everything else in this repository put together, and getting it subtly wrong
produces the class of bug — a lost wakeup under load — that is nearly impossible to reproduce and
therefore nearly impossible to fix. `49` §20 says to spend the zero-dependency position
deliberately; this is the single most defensible thing to spend it on.

## Why these features and not the defaults

`default-features = false` is a security control here, not tidiness. The precedent is
`00-CLOSURE.md`'s section on the same flag for the crypto crates, where the defaults pulled in
`getrandom` and would have put a host import in the WASM module.

The five enabled features are the ones the skeleton actually uses:

| feature | what needs it |
|---|---|
| `rt-multi-thread` | the runtime itself |
| `net` | the TCP listener |
| `macros` | `#[tokio::main]` and `select!` |
| `signal` | graceful shutdown on SIGTERM — a container's stop signal, `43` §5.4 |
| `time` | timeouts, including the health check's own |

Notably **absent**: `process` and `io-std`. A server that never spawns a process is a smaller thing
to reason about, and the day one of them is needed is the day someone writes down why.

## `fs`, added 2026-09-14, and this is the writing-down

The line above said `fs` was absent too. It is now enabled, so here is the why it asked for.

`GET /firmware/fetch/{token}` serves a staged firmware image, up to two gibibytes, to a network
device (ADR-0045). The first build read the whole file into memory to answer the request, which on a
route that carries **no session** — the URL is the credential, because a switch cannot sign a request
— is a denial-of-service surface. Streaming it needs `tokio_util::io::ReaderStream`
(`deps/decisions/tokio-util.md`, owner-approved the same day), `ReaderStream` needs an `AsyncRead`,
and the only `AsyncRead` over a file is `tokio::fs::File`.

**It is a feature, not a dependency.** tokio's own manifest has `fs = []`: it pulls nothing. The
lockfile is byte-identical with and without it and gate-zero counts the same 141 packages, both
checked on 2026-09-14.

What it actually adds is a wrapper that hands file operations to the blocking pool — the same
mechanism the firmware upload path already hand-rolls with `spawn_blocking` around `std::fs`. So the
sentence this replaces is no longer quite true in a second way: the server had already begun reading
and writing files, through `std::fs` on a blocking thread, before this feature existed. Enabling
`fs` makes that explicit rather than introducing it.

Measured after the change, serving a one-gibibyte image: **315,392 bytes of resident growth**, about
one read buffer. A control that reinstated the buffered read grew the same process by the full image
size, which is how the measurement was shown to be capable of failing.

## Advisories

Checked against a fresh `RustSec/advisory-db` clone on **2026-09-03**. Five advisories exist
against `tokio` and **every one is patched at or below 1.53.1**:

| Advisory | Patched | Note |
|---|---|---|
| RUSTSEC-2025-0023 | ≥ 1.44.2 | broadcast channel clones in parallel without requiring `Sync` (unsound) |
| RUSTSEC-2023-0005 | ≥ 1.18.4 | |
| RUSTSEC-2023-0001 | ≥ 1.24.2 | |
| RUSTSEC-2021-0124 | ≥ 1.13.1 | |
| RUSTSEC-2021-0072 | ≥ 1.8.4 | |

`cargo audit` and `cargo deny` now check this mechanically on every push, which the two
2026-08-15 records could not say.

## The version, re-read

`49` §6's table was read on 2026-08-21 and WO-11 §7 trigger 1 requires re-reading it before
pinning. Re-read from the crates.io sparse index on **2026-09-03**: `1.53.1` is still the latest
live version, unmoved and unyanked. Published **2026-07-20**, 45 days before this pin — well
outside `scripts/crate-cooldown.sh`'s seven-day window.
