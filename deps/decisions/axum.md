# `axum` — approved 2026-09-03

| | |
|---|---|
| **Job** | The HTTP layer, and later the WebSocket transport. `41` §5.2 chose it and `49` §6 keeps the choice. It is a thin router over `hyper` and `tower`, which matters here: the parts that actually parse untrusted bytes are `hyper` and `httparse`, and axum is the part that decides which function sees them |
| **Version** | `0.8.9`, **`default-features = false`**, features `http1`, `tokio` |
| **Publisher** | The Tokio project (`tokio-rs`). Repository `https://github.com/tokio-rs/axum` — read from the crate's own metadata 2026-09-03. See `00-CLOSURE-SERVER.md` on why a repository URL is a proxy for a publisher and not the answer |
| **Licence** | MIT — compatible with ADR-0004, on `deny.toml`'s allow list |
| **Ships or tooling** | **Ships.** Linked into the `fathom-server` binary, and never into the WASM module |
| **`build.rs`** | None in this crate. Its closure adds `httparse`, which has one |
| **Proc macros** | None enabled. `axum-macros` is a separate crate and is not pulled in |
| **Determinism** | Not deterministic and does not need to be — the same reasoning as `tokio.md`. Request handling is the host boundary; what must reproduce is what the server *computes* from a graph, which takes no router |

## Why not first-party

Writing the HTTP layer means writing an HTTP/1.1 parser, and an HTTP/1.1 parser is the single
most attacked piece of code in any web server. The failure mode is not a crash — it is a
**parser differential**: two implementations disagreeing about where a request ends, which is
request smuggling. `hyper`'s changelog for the very version pinned here contains four fixes in
exactly that area (see `00-COOLDOWN-EXCEPTIONS.md`), which is the argument in miniature: this is
code that gets found and fixed because thousands of people run it, and a hand-rolled version
gets neither.

## Why these features and not the defaults

`default-features = false`, and the enabled list is two entries because `/health` is the only
endpoint this order builds:

| feature | what needs it |
|---|---|
| `http1` | the protocol, terminated behind Caddy (`43` §5.4) |
| `tokio` | the runtime integration and the TCP listener glue |

Deliberately **absent**: `json` (nothing serialises yet, and it drags `serde` and `serde_json` in
— when it arrives it gets its own line in the closure and someone looks at it), `form`, `query`,
`original-uri`, `matched-path`, and axum's own `tracing` feature, which is not the same thing as
depending on `tracing` and is not needed to log from a handler. **`http2` is absent too**, and
that is a decision rather than an oversight: TLS and protocol negotiation happen in Caddy in front
(`49` §6's C7 argument), so the binary speaks HTTP/1 over loopback.

**`ws` is absent and will be needed.** `49` §6 carries a standing instruction for when it lands:
use axum's own `ws` feature, **not** `tokio-tungstenite` added separately, because that is two
copies of the same protocol code in one closure.

## Request body limits

RUSTSEC-2022-0055 against `axum-core` is *"No default limit put on request bodies"*, patched at
≥ 0.2.8. The version here is `axum-core 0.5.6`, far past it, and axum has applied a default body
limit since 0.6. Recorded rather than skipped because the **advisory is about a default, not a
bug**: when this server grows an endpoint that accepts a body, the limit for that endpoint is a
decision to make explicitly with `DefaultBodyLimit`, not one to inherit.

## Advisories

Checked against a fresh `RustSec/advisory-db` clone on **2026-09-03**, and mechanically by
`cargo audit` and `cargo deny` on every push.

**Zero against `axum` itself.** Its closure carries historic advisories against `axum-core`,
`hyper`, `http`, `bytes`, `slab`, `futures-util`, `futures-task`, `smallvec` and `socket2`, and
**every one is patched below the pinned version.** The two recent enough to be worth naming:

| Advisory | Crate | Patched | In use |
|---|---|---|---|
| RUSTSEC-2026-0007 | `bytes` | ≥ 1.11.1 | 1.12.1 |
| RUSTSEC-2025-0047 | `slab` | ≥ 0.4.11 | 0.4.12 |

## The version, re-read

`49` §6's table was read 2026-08-21; WO-11 §7 trigger 1 requires re-reading before pinning.
Re-read from the crates.io sparse index on **2026-09-03**: `0.8.9` is still the latest live
version, unmoved and unyanked. Published **2026-08-19**, 15 days before this pin — outside the
seven-day cooldown window. (`0.8.2` is yanked; it is not in use.)
