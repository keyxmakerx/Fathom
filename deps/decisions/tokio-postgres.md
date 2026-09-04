# `tokio-postgres` — approved 2026-09-03

| | |
|---|---|
| **Job** | The PostgreSQL driver. `49` §6 chose it over `sqlx` on a measurement — **58 crates in the build graph against sqlx's 124**, measured 2026-08-21 — and `35` §5.1's cap is ≤ 160 in the closure, so sqlx would have spent 36 of the remaining budget on one convenience |
| **Version** | `0.7.18`, default features (`runtime`) |
| **Publisher** | `rust-postgres` / Steven Fackler. Repository `https://github.com/sfackler/rust-postgres` — from the crate's own metadata 2026-09-03; a proxy for a publisher, not the answer |
| **Licence** | MIT OR Apache-2.0 — compatible with ADR-0004 |
| **Ships or tooling** | **Ships.** In the binary only |
| **`build.rs`** | None in this crate |
| **Proc macros** | None of its own; it depends on `async-trait`, which is one |
| **Determinism** | Row order is the database's, not this crate's. Anything Fathom computes from stored rows must impose its own order — the same rule invariant 9 already applies to hash iteration |

## NO TLS FEATURE, AND THAT IS WO-11 TRIGGER 4 MADE CONCRETE

`49` §6 keeps **C7 — no C or C++ in the shipped closure** — only if TLS is terminated **in front
of** the binary, because `rustls`'s crypto provider (`ring` or `aws-lc-sys`) brings C and assembly
back in. `43` §5.4 already decided TLS in front by default, and WO-11 §7 trigger 4 says C7 is a
decision rather than a detail: *"if `rustls`'s crypto provider is in the closure, stop."*

So **neither `with-native-tls` nor `with-rustls` is enabled**, and PostgreSQL sits on a Unix
socket or loopback where there is nothing to encrypt against.

**Verified, not assumed.** `cargo tree -p fathom-server --target x86_64-unknown-linux-gnu` on
2026-09-03 contains no `rustls`, no `ring`, no `aws-lc-sys`, no `openssl-sys` and no `native-tls`.
The only C-adjacent crate is `libc`, which is a set of `extern` declarations and compiles no C.
`deny.toml` bans all four carriers by name, so the decision cannot be undone by a transitive
arrival without failing the build.

`49` §21 item 21 recorded that dependency resolution differed between two scratch builds on
exactly this question. It is resolved here, on the real manifest.

## The advisory this version exists to fix

**RUSTSEC-2026-0178** (2026-06-12, GHSA-3gjw-f78c-vvpw), patched at **≥ 0.7.18** — which is
exactly the version `49` §6 named on 2026-08-21 and this order pinned after re-reading it:

> A malicious or compromised server can send a row containing fewer fields than its row
> description declares columns. Reading one of the missing columns then panics with an
> out-of-bounds index, aborting the calling task. **This affects even the otherwise non-panicking
> `try_get`**, and both `Row` and `SimpleQueryRow`.

Two more in the same family, both in `postgres-protocol` and both patched at ≥ 0.6.12 (the version
here is 0.6.12, required by `tokio-postgres 0.7.18` itself):

| Advisory | What |
|---|---|
| RUSTSEC-2026-0179 | Unbounded SCRAM PBKDF2 iteration count — a malicious server pins a tokio worker thread for minutes per connection |
| RUSTSEC-2026-0180 | Panic decoding a malformed binary `hstore` value |

**All three share a threat model worth writing down**, because it decides how much they matter
here: *"Applications that connect only to a trusted database are not exposed; the risk applies to
clients that may connect to untrusted or user-supplied servers, or whose connection can be
intercepted by a man-in-the-middle."* Fathom's server connects to its own PostgreSQL over a Unix
socket or loopback, so it is in the first category — **provided that stays true**. The day a
deployment lets an operator point Fathom at a database URL they supply, these three move from
patched-anyway to load-bearing, and the TLS decision above has to be revisited with them.

## `whoami` is unconditional, and it costs fourteen crates

`tokio-postgres 0.7.18` declares `whoami = "2.0.1"` with **no feature gate at all** — checked in
the crate's own manifest on 2026-09-03. It is used to default the connection's user name to the
process owner's. It cannot be turned off.

What it brings, none of which compiles for this server: `wasite`, `wasi 0.14`, `wasm-bindgen` and
its four companion crates, `js-sys`, `web-sys`, `objc2-core-foundation`,
`objc2-system-configuration`, `libredox`, `redox_syscall`, `r-efi`, `wit-bindgen`, `bumpalo`,
`rustversion`.

**They are target-gated, not compiled, and they are still real cost**: every one sits in
`Cargo.lock`, must be recorded, is cooldown-checked on every CI run, and is a name in the graph
whose next release could matter. It is also where two of the three young-crate cooldown failures
on this arrival came from. `49` §6's *"58 crates"* measurement did not account for it; the
re-measurement is in `00-CLOSURE-SERVER.md`.

## The version, re-read

`49` §6's table was read 2026-08-21; re-read from the crates.io sparse index on **2026-09-03**:
`0.7.18` is the latest live version, unmoved and unyanked, and it is the patch for
RUSTSEC-2026-0178. Published 2026-06-12 or later — well outside the seven-day cooldown window.
