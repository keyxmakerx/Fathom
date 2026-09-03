# The measured closure — the server side

> **Status: measured 2026-09-03 by `./scripts/closure-report.sh`, from `cargo metadata`, the
> fetched source trees and `static.crates.io`. Not typed from memory — WO-11 §6 G4.**
>
> **Regenerate it, do not edit it.** Every arrival of a dependency re-runs the script and the
> table below is replaced wholesale. A hand-edited row is a row nobody measured.

`scripts/gate-zero.sh` reads the first column of the table between the markers. A crate named
there may appear in `Cargo.lock` without an individual record; a crate this workspace **names in
a manifest** always needs its own record regardless, because Fathom chose it.

## The approval

ADR-0032 §5 makes crate approval an owner act that may not be delegated. WO-11 was authored
blocked on exactly that and the owner lifted it on **2026-09-03**, in these words:

> *"Oh no you can use borrowed code, much of those original constraints are gone, the important
> part, and idk how we want to manage this if we can have git have some sort of security checker,
> and have security in your like context at all times, but this is intended to be an enterprise
> level thing."*

So the approval is **the closure pattern plus the checker**, not 109 separate signatures.
WO-11 Disagreements 1 is the argument for why that is the stronger control and not the weaker
one: the only way one person completes 109 approvals is by skimming, and a rubber stamp on 109
files is indistinguishable from no review while looking like thorough review. What is preserved
is an individual, reasoned record for every crate Fathom **chooses** — see `tokio.md` — and one
approved document naming every crate that arrives *because* of those choices, with the columns
the August 2026 attack was actually about.

## What each column is measured from, and the one it cannot measure

`crate`, `version`, `licence` and `direct` come from `cargo metadata`. `build.rs` is read from the
fetched source tree under `~/.cargo/registry/src` — **that is the column the August 2026 attack
was about**: `proc-macro1`'s build script downloaded and executed a payload, so merely compiling
was enough (RUSTSEC-2026-0260, 2026-08-20). `proc-macro` is the same hazard by a different door.
`published` is the `Last-Modified` of the `.crate` file on `static.crates.io`, the same figure
`scripts/crate-cooldown.sh` gates on.

**`publisher` is absent and that is deliberate.** Neither `cargo metadata` nor the sparse index
carries crates.io ownership; only the JSON API does. The `repository` column is printed instead
and it is a **proxy, not the answer** — a repository URL is written by the crate's author and
proves nothing about who holds the publish token. Naming a publisher from a repository URL would
be exactly the kind of confident guess ADR-0034 forbids.

## The closure

<!-- gate-zero:closure approved-by="the owner" date="2026-09-03" -->

| crate | version | licence | direct | build.rs | proc-macro | published | repository |
|---|---|---|---|---|---|---|---|
| `async-trait` | `0.1.92` | MIT OR Apache-2.0 | transitive | no | yes | Sat, 08 Aug 2026 07:10:36 GMT | https://github.com/dtolnay/async-trait |
| `atomic-waker` | `1.1.2` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 14:59:32 GMT | https://github.com/smol-rs/atomic-waker |
| `axum` | `0.8.9` | MIT | DIRECT | no | no | Sun, 28 Jun 2026 18:07:52 GMT | https://github.com/tokio-rs/axum |
| `axum-core` | `0.5.6` | MIT | transitive | no | no | Sun, 28 Jun 2026 17:11:24 GMT | https://github.com/tokio-rs/axum |
| `base64` | `0.22.1` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 14:36:55 GMT | https://github.com/marshallpierce/rust-base64 |
| `bitflags` | `2.13.1` | MIT OR Apache-2.0 | transitive | no | no | Wed, 15 Jul 2026 20:36:21 GMT | https://github.com/bitflags/bitflags |
| `block-buffer` | `0.12.1` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:55:10 GMT | https://github.com/RustCrypto/utils |
| `bumpalo` | `3.20.3` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 18:15:49 GMT | https://github.com/fitzgen/bumpalo |
| `byteorder` | `1.5.0` | Unlicense OR MIT | transitive | no | no | Sun, 28 Jun 2026 15:18:27 GMT | https://github.com/BurntSushi/byteorder |
| `bytes` | `1.12.1` | MIT | transitive | no | no | Wed, 08 Jul 2026 10:01:30 GMT | https://github.com/tokio-rs/bytes |
| `cfg-if` | `1.0.4` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 16:58:08 GMT | https://github.com/rust-lang/cfg-if |
| `chacha20` | `0.10.2` | MIT OR Apache-2.0 | transitive | no | no | Thu, 27 Aug 2026 17:51:14 GMT | https://github.com/RustCrypto/stream-ciphers |
| `cmov` | `0.5.4` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 17:09:19 GMT | https://github.com/RustCrypto/utils |
| `const-oid` | `0.10.2` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 16:35:58 GMT | https://github.com/RustCrypto/formats |
| `cpufeatures` | `0.3.1` | MIT OR Apache-2.0 | transitive | no | no | Wed, 26 Aug 2026 18:40:00 GMT | https://github.com/RustCrypto/utils |
| `crypto-common` | `0.2.2` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:54:18 GMT | https://github.com/RustCrypto/traits |
| `ctutils` | `0.4.2` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 17:39:09 GMT | https://github.com/RustCrypto/utils |
| `deadpool` | `0.13.1` | MIT OR Apache-2.0 | transitive | no | no | Wed, 26 Aug 2026 15:11:02 GMT | https://github.com/deadpool-rs/deadpool |
| `deadpool-postgres` | `0.14.2` | MIT OR Apache-2.0 | DIRECT | no | no | Wed, 26 Aug 2026 15:14:51 GMT | https://github.com/deadpool-rs/deadpool |
| `deadpool-runtime` | `0.3.1` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:36:45 GMT | https://github.com/deadpool-rs/deadpool |
| `digest` | `0.11.3` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:57:12 GMT | https://github.com/RustCrypto/traits |
| `errno` | `0.3.14` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:08:03 GMT | https://github.com/lambda-fairy/rust-errno |
| `fallible-iterator` | `0.2.0` | MIT/Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 14:36:53 GMT | https://github.com/sfackler/rust-fallible-iterator |
| `futures-channel` | `0.3.34` | MIT OR Apache-2.0 | transitive | no | no | Tue, 11 Aug 2026 12:13:11 GMT | https://github.com/rust-lang/futures-rs |
| `futures-core` | `0.3.34` | MIT OR Apache-2.0 | transitive | no | no | Tue, 11 Aug 2026 12:13:02 GMT | https://github.com/rust-lang/futures-rs |
| `futures-sink` | `0.3.34` | MIT OR Apache-2.0 | transitive | no | no | Tue, 11 Aug 2026 12:13:07 GMT | https://github.com/rust-lang/futures-rs |
| `futures-task` | `0.3.34` | MIT OR Apache-2.0 | transitive | no | no | Tue, 11 Aug 2026 12:13:08 GMT | https://github.com/rust-lang/futures-rs |
| `futures-util` | `0.3.34` | MIT OR Apache-2.0 | transitive | no | no | Tue, 11 Aug 2026 12:13:20 GMT | https://github.com/rust-lang/futures-rs |
| `getrandom` | `0.4.3` | MIT OR Apache-2.0 | transitive | yes | no | Sun, 28 Jun 2026 18:10:53 GMT | https://github.com/rust-random/getrandom |
| `hmac` | `0.13.0` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 15:58:58 GMT | https://github.com/RustCrypto/MACs |
| `http` | `1.5.0` | MIT OR Apache-2.0 | transitive | no | no | Wed, 29 Jul 2026 14:57:23 GMT | https://github.com/hyperium/http |
| `http-body` | `1.1.0` | MIT | transitive | no | no | Mon, 13 Jul 2026 17:25:07 GMT | https://github.com/hyperium/http-body |
| `http-body-util` | `0.1.5` | MIT | transitive | no | no | Wed, 12 Aug 2026 15:22:22 GMT | https://github.com/hyperium/http-body |
| `httparse` | `1.10.1` | MIT OR Apache-2.0 | transitive | yes | no | Sun, 28 Jun 2026 16:52:46 GMT | https://github.com/seanmonstar/httparse |
| `httpdate` | `1.0.3` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 15:19:36 GMT | https://github.com/pyfisch/httpdate |
| `hybrid-array` | `0.4.14` | MIT OR Apache-2.0 | transitive | no | no | Thu, 30 Jul 2026 16:40:05 GMT | https://github.com/RustCrypto/hybrid-array |
| `hyper` | `1.11.1` | MIT | transitive | no | no | Fri, 28 Aug 2026 12:22:32 GMT | https://github.com/hyperium/hyper |
| `hyper-util` | `0.1.20` | MIT | transitive | no | no | Sun, 28 Jun 2026 16:55:10 GMT | https://github.com/hyperium/hyper-util |
| `itoa` | `1.0.18` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:55:52 GMT | https://github.com/dtolnay/itoa |
| `js-sys` | `0.3.104` | MIT OR Apache-2.0 | transitive | no | no | Sat, 08 Aug 2026 00:57:02 GMT | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/js-sys |
| `lazy_static` | `1.5.0` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 16:21:05 GMT | https://github.com/rust-lang-nursery/lazy-static.rs |
| `libc` | `0.2.189` | MIT OR Apache-2.0 | transitive | yes | no | Tue, 21 Jul 2026 21:33:29 GMT | https://github.com/rust-lang/libc |
| `libredox` | `0.1.21` | MIT | transitive | no | no | Thu, 27 Aug 2026 17:46:44 GMT | https://gitlab.redox-os.org/redox-os/libredox.git |
| `lock_api` | `0.4.14` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 15:08:36 GMT | https://github.com/Amanieu/parking_lot |
| `log` | `0.4.34` | MIT OR Apache-2.0 | transitive | no | no | Sat, 22 Aug 2026 11:44:29 GMT | https://github.com/rust-lang/log |
| `matchit` | `0.8.4` | MIT AND BSD-3-Clause | transitive | no | no | Sun, 28 Jun 2026 14:48:04 GMT | https://github.com/ibraheemdev/matchit |
| `md-5` | `0.11.0` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:52:35 GMT | https://github.com/RustCrypto/hashes |
| `memchr` | `2.8.3` | Unlicense OR MIT | transitive | no | no | Wed, 08 Jul 2026 00:49:55 GMT | https://github.com/BurntSushi/memchr |
| `mime` | `0.3.17` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 15:18:11 GMT | https://github.com/hyperium/mime |
| `mio` | `1.2.2` | MIT | transitive | no | no | Mon, 13 Jul 2026 15:39:11 GMT | https://github.com/tokio-rs/mio |
| `objc2-core-foundation` | `0.3.2` | Zlib OR Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 15:53:07 GMT | https://github.com/madsmtm/objc2 |
| `objc2-system-configuration` | `0.3.2` | Zlib OR Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 16:36:00 GMT | https://github.com/madsmtm/objc2 |
| `once_cell` | `1.21.4` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 15:34:01 GMT | https://github.com/matklad/once_cell |
| `parking_lot` | `0.12.5` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 15:08:29 GMT | https://github.com/Amanieu/parking_lot |
| `parking_lot_core` | `0.9.12` | MIT OR Apache-2.0 | transitive | yes | no | Sun, 28 Jun 2026 15:08:48 GMT | https://github.com/Amanieu/parking_lot |
| `percent-encoding` | `2.3.2` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 14:59:33 GMT | https://github.com/servo/rust-url/ |
| `phf` | `0.13.1` | MIT | transitive | no | no | Sun, 28 Jun 2026 17:04:03 GMT | https://github.com/rust-phf/rust-phf |
| `phf_shared` | `0.13.1` | MIT | transitive | no | no | Sun, 28 Jun 2026 17:04:01 GMT | https://github.com/rust-phf/rust-phf |
| `pin-project-lite` | `0.2.17` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 14:40:19 GMT | https://github.com/taiki-e/pin-project-lite |
| `postgres-protocol` | `0.6.12` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:10:21 GMT | https://github.com/rust-postgres/rust-postgres |
| `postgres-types` | `0.2.14` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 16:41:16 GMT | https://github.com/rust-postgres/rust-postgres |
| `proc-macro2` | `1.0.107` | MIT OR Apache-2.0 | transitive | yes | no | Sun, 19 Jul 2026 00:18:26 GMT | https://github.com/dtolnay/proc-macro2 |
| `quote` | `1.0.47` | MIT OR Apache-2.0 | transitive | yes | no | Sun, 19 Jul 2026 00:16:58 GMT | https://github.com/dtolnay/quote |
| `r-efi` | `6.0.0` | MIT OR Apache-2.0 OR LGPL-2.1-or-later | transitive | no | no | Sun, 28 Jun 2026 15:43:22 GMT | https://github.com/r-efi/r-efi |
| `rand` | `0.10.2` | MIT OR Apache-2.0 | transitive | no | no | Thu, 02 Jul 2026 09:01:40 GMT | https://github.com/rust-random/rand |
| `rand_core` | `0.10.1` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:28:08 GMT | https://github.com/rust-random/rand_core |
| `redox_syscall` | `0.5.18` | MIT | transitive | no | no | Sun, 28 Jun 2026 15:52:34 GMT | https://gitlab.redox-os.org/redox-os/syscall |
| `rustversion` | `1.0.23` | MIT OR Apache-2.0 | transitive | no | yes | Tue, 07 Jul 2026 02:10:27 GMT | https://github.com/dtolnay/rustversion |
| `scopeguard` | `1.2.0` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 15:31:51 GMT | https://github.com/bluss/scopeguard |
| `serde` | `1.0.229` | MIT OR Apache-2.0 | transitive | yes | no | Sat, 18 Jul 2026 23:05:14 GMT | https://github.com/serde-rs/serde |
| `serde_core` | `1.0.229` | MIT OR Apache-2.0 | transitive | yes | no | Sat, 18 Jul 2026 23:05:12 GMT | https://github.com/serde-rs/serde |
| `serde_derive` | `1.0.229` | MIT OR Apache-2.0 | transitive | no | yes | Sat, 18 Jul 2026 23:05:08 GMT | https://github.com/serde-rs/serde |
| `sha2` | `0.11.0` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:17:31 GMT | https://github.com/RustCrypto/hashes |
| `sharded-slab` | `0.1.7` | MIT | transitive | no | no | Sun, 28 Jun 2026 15:19:03 GMT | https://github.com/hawkw/sharded-slab |
| `signal-hook-registry` | `1.4.8` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 16:11:53 GMT | https://github.com/vorner/signal-hook |
| `siphasher` | `1.0.3` | MIT/Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 16:03:43 GMT | https://github.com/jedisct1/rust-siphash |
| `slab` | `0.4.12` | MIT | transitive | no | no | Sun, 28 Jun 2026 17:09:00 GMT | https://github.com/tokio-rs/slab |
| `smallvec` | `1.15.2` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 18:21:48 GMT | https://github.com/servo/rust-smallvec |
| `socket2` | `0.6.5` | MIT OR Apache-2.0 | transitive | no | no | Mon, 13 Jul 2026 19:45:59 GMT | https://github.com/rust-lang/socket2 |
| `stringprep` | `0.1.5` | MIT/Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 15:07:50 GMT | https://github.com/sfackler/rust-stringprep |
| `syn` | `2.0.119` | MIT OR Apache-2.0 | transitive | no | no | Wed, 15 Jul 2026 00:23:50 GMT | https://github.com/dtolnay/syn |
| `syn` | `3.0.4` | MIT OR Apache-2.0 | transitive | no | no | Mon, 24 Aug 2026 00:39:55 GMT | https://github.com/dtolnay/syn |
| `sync_wrapper` | `1.0.2` | Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 16:27:08 GMT | https://github.com/Actyx/sync_wrapper |
| `thread_local` | `1.1.10` | MIT OR Apache-2.0 | transitive | no | no | Fri, 10 Jul 2026 21:20:30 GMT | https://github.com/Amanieu/thread_local-rs |
| `tinyvec` | `1.12.0` | Zlib OR Apache-2.0 OR MIT | transitive | no | no | Fri, 10 Jul 2026 20:03:57 GMT | https://github.com/Lokathor/tinyvec |
| `tinyvec_macros` | `0.1.1` | MIT OR Apache-2.0 OR Zlib | transitive | no | no | Sun, 28 Jun 2026 16:00:36 GMT | https://github.com/Soveu/tinyvec_macros |
| `tokio` | `1.53.1` | MIT | DIRECT | no | no | Mon, 20 Jul 2026 17:06:11 GMT | https://github.com/tokio-rs/tokio |
| `tokio-macros` | `2.7.2` | MIT | transitive | no | yes | Wed, 29 Jul 2026 13:15:28 GMT | https://github.com/tokio-rs/tokio |
| `tokio-postgres` | `0.7.18` | MIT OR Apache-2.0 | DIRECT | no | no | Sun, 28 Jun 2026 16:47:48 GMT | https://github.com/rust-postgres/rust-postgres |
| `tokio-util` | `0.7.19` | MIT | transitive | no | no | Tue, 21 Jul 2026 12:10:48 GMT | https://github.com/tokio-rs/tokio |
| `tower` | `0.5.3` | MIT | transitive | no | no | Sun, 28 Jun 2026 16:05:58 GMT | https://github.com/tower-rs/tower |
| `tower-layer` | `0.3.3` | MIT | transitive | no | no | Sun, 28 Jun 2026 16:09:52 GMT | https://github.com/tower-rs/tower |
| `tower-service` | `0.3.3` | MIT | transitive | no | no | Sun, 28 Jun 2026 16:10:30 GMT | https://github.com/tower-rs/tower |
| `tracing` | `0.1.44` | MIT | DIRECT | no | no | Sun, 28 Jun 2026 17:15:09 GMT | https://github.com/tokio-rs/tracing |
| `tracing-attributes` | `0.1.31` | MIT | transitive | no | yes | Sun, 28 Jun 2026 16:54:09 GMT | https://github.com/tokio-rs/tracing |
| `tracing-core` | `0.1.36` | MIT | transitive | no | no | Sun, 28 Jun 2026 17:13:19 GMT | https://github.com/tokio-rs/tracing |
| `tracing-subscriber` | `0.3.23` | MIT | DIRECT | no | no | Sun, 28 Jun 2026 17:52:18 GMT | https://github.com/tokio-rs/tracing |
| `typenum` | `1.20.1` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 14:49:45 GMT | https://github.com/paholg/typenum |
| `unicode-bidi` | `0.3.18` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 16:33:05 GMT | https://github.com/servo/unicode-bidi |
| `unicode-ident` | `1.0.24` | (MIT OR Apache-2.0) AND Unicode-3.0 | transitive | no | no | Sun, 28 Jun 2026 15:42:04 GMT | https://github.com/dtolnay/unicode-ident |
| `unicode-normalization` | `0.1.25` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 15:02:20 GMT | https://github.com/unicode-rs/unicode-normalization |
| `unicode-properties` | `0.1.4` | MIT/Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 14:56:18 GMT | https://github.com/unicode-rs/unicode-properties |
| `wasi` | `0.11.1+wasi-snapshot-preview1` | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 16:14:11 GMT | https://github.com/bytecodealliance/wasi |
| `wasi` | `0.14.7+wasi-0.2.4` | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 16:14:19 GMT | https://github.com/bytecodealliance/wasi-rs |
| `wasip2` | `1.0.4+wasi-0.2.12` | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 17:34:32 GMT | https://github.com/bytecodealliance/wasi-rs |
| `wasite` | `1.0.2` | Apache-2.0 OR BSL-1.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 16:46:33 GMT | https://github.com/ardaku/wasite |
| `wasm-bindgen` | `0.2.127` | MIT OR Apache-2.0 | transitive | yes | no | Sat, 08 Aug 2026 00:57:00 GMT | https://github.com/wasm-bindgen/wasm-bindgen |
| `wasm-bindgen-macro` | `0.2.127` | MIT OR Apache-2.0 | transitive | no | yes | Sat, 08 Aug 2026 00:56:58 GMT | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/macro |
| `wasm-bindgen-macro-support` | `0.2.127` | MIT OR Apache-2.0 | transitive | no | no | Sat, 08 Aug 2026 00:56:56 GMT | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/macro-support |
| `wasm-bindgen-shared` | `0.2.127` | MIT OR Apache-2.0 | transitive | yes | no | Sat, 08 Aug 2026 00:56:53 GMT | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/shared |
| `web-sys` | `0.3.104` | MIT OR Apache-2.0 | transitive | no | no | Sat, 08 Aug 2026 00:57:05 GMT | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/web-sys |
| `whoami` | `2.1.3` | Apache-2.0 OR BSL-1.0 OR MIT | transitive | no | no | Tue, 11 Aug 2026 23:31:58 GMT | https://github.com/ardaku/whoami |
| `windows-link` | `0.2.1` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:12:27 GMT | https://github.com/microsoft/windows-rs |
| `windows-sys` | `0.61.2` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:13:16 GMT | https://github.com/microsoft/windows-rs |
| `wit-bindgen` | `0.57.1` | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | transitive | yes | no | Sun, 28 Jun 2026 18:22:51 GMT | https://github.com/bytecodealliance/wit-bindgen |

**115 external crates**, of which **6 direct**. **11 carry a `build.rs`** and **6 are proc-macros** — 17 of 115 run code at compile time, which is the number the August 2026 attack was about. Against `35` §5.1: **≤ 30 direct (6)**, **≤ 160 in the closure (115)**.

<!-- gate-zero:end -->

## What the gates said on arrival

Every one of these was run on a real resolution, not a fixture. Kept as a record because the
point of the order is the gate, not the server.

### `tokio` — 15 crates, 1 direct

- **`gate-zero` failed first**, naming all fifteen, and correctly separated `tokio` as a
  **DIRECT** dependency needing its own record from the fourteen transitive ones a closure may
  carry. That distinction is the whole content of WO-11 §5 step 1 and this was its first real
  exercise.
- **`scripts/lockfile-lookalikes.sh` passed** across 32 packages. Worth noting what is now in the
  graph: **`proc-macro2` itself**, the crate whose typosquat `proc-macro1` was the August 2026
  attack's vehicle. The look-alike check now has its real target to sit beside.
- **`scripts/crate-cooldown.sh` FAILED, and it was right.** `mio 1.2.3` had been published **the
  previous day**. Nothing suggests it is malicious; that is the point — a cooldown does not ask
  whether a release is bad, it declines to be the first to find out. Pinned back to **`mio
  1.2.2`** (2026-07-13). 1.2.3's changelog is Wine support, a Unix-domain-socket re-registration
  fix under `poll(2)`, and a BSD waker change: nothing security-relevant and nothing touching the
  Linux `epoll` path this server runs on. Both RustSec advisories against `mio`
  (RUSTSEC-2020-0081, RUSTSEC-2024-0019) are patched at ≥ 0.7.6 and ≥ 0.8.11, far below 1.2.2.
  **A hold, not a rejection** — revisit once 1.2.3 is a week old.

### `axum` — 43 crates, 2 direct

- **`gate-zero` failed on twenty-eight new crates**, again separating `axum` as direct.
- **The cooldown failed twice more, and the two were resolved differently**, which is the
  interesting part. `smallvec 1.16.0` (two days old) was **pinned back** to 1.15.2 — no security
  content, and a `SmallVec` is on no parsing path here, so nothing is lost by waiting.
  `hyper 1.11.1` (six days old) was **excepted, with an expiry**, because holding it back would
  have been the riskier move: 1.11.1 carries four HTTP/1 parser fixes in exactly the area where a
  differential is a request-smuggling bug. `00-COOLDOWN-EXCEPTIONS.md` carries the reasoning and
  the expiry date, and the mechanism was built for this rather than lowering the window globally.
- **`cargo deny` and `cargo audit` clean over all 43.** Nine crates in the closure carry historic
  advisories — `axum-core`, `hyper`, `http`, `bytes`, `slab`, `futures-util`, `futures-task`,
  `smallvec`, `socket2` — and every one is patched below the pinned version. The two recent
  enough to name: RUSTSEC-2026-0007 against `bytes` (patched ≥ 1.11.1, in use 1.12.1) and
  RUSTSEC-2025-0047 against `slab` (patched ≥ 0.4.11, in use 0.4.12).

### `tracing` and `tracing-subscriber` — 51 crates, 4 direct

- **Eight new crates, and the cooldown was clean** — the first arrival that cost nothing at that
  layer.
- **What the feature flags saved is the interesting number.** `env-filter` would have added five
  crates (`regex`, `regex-automata`, `regex-syntax`, `aho-corasick`, `memchr`) to parse a filter
  string, and `json` would have added `serde` and `serde_json`. Both are off, with the cost of
  turning them on written down in `tracing-subscriber.md` rather than left for a later session to
  discover. Seven crates is 4% of `35` §5.1's whole ≤ 160 budget, spent on convenience.
- **`ansi` is off too**, which is RUSTSEC-2025-0055 (ANSI escape sequences in logged user input)
  handled twice: the pin is past the patch, and the code that writes an escape sequence is not
  compiled in.
- `tracing 0.1.42` and `tracing-subscriber 0.3.21` are **yanked** and neither is in use.
  `deny.toml` sets `yanked = "deny"`, so landing on one would fail the build rather than proceed.

### `tokio-postgres` and `deadpool-postgres` — 115 crates, 6 direct

The largest arrival by far: **63 new crates in one resolution.**

- **The cooldown failed twice more.** `tinyvec 1.13.0` had been published **that same day** and
  `libredox 0.1.23` two days earlier; both were **pinned back** (1.12.0 and 0.1.21) rather than
  excepted, because neither has security content and nothing is lost by waiting. Three of the four
  cooldown failures across this whole order came from crates nobody chose.
- **`cargo deny` failed on duplicates, twice, and both are recorded rather than smoothed over.**
  `wasi` 0.11 (via `mio`) beside `wasi` 0.14 (via `whoami` → `wasite`); and `syn` 2.0.119 (via
  `tracing-attributes`) beside `syn` 3.0.4 (via `async-trait` and `tokio-macros`). Each is a
  `[[bans.skip]]` entry naming the **exact version** with its reason, so a third copy would fail
  again. `multiple-versions` was **not** relaxed to `warn`.
- **THE FEATURE-UNIFICATION FINDING.** The second `syn` exists because
  `deadpool-postgres 0.14.2` declares `tracing` without `default-features = false`, which turns
  `attributes` back on across the graph even though `crates/fathom-server/Cargo.toml` asks for it
  off. A feature disabled in your own manifest is a **request, not a guarantee**. `tracing.md`
  carries the correction, because this record had already claimed the feature was off.
- **C7 HOLDS, AND IT WAS VERIFIED RATHER THAN ASSUMED** (WO-11 §7 trigger 4).
  `cargo tree -p fathom-server --target x86_64-unknown-linux-gnu` on 2026-09-03 contains no
  `rustls`, no `ring`, no `aws-lc-sys`, no `openssl-sys` and no `native-tls`. The only C-adjacent
  crate is `libc`, which compiles no C. `deny.toml` bans all four carriers by name, so the
  decision cannot be undone by a transitive arrival without failing the build. `49` §21 item 21
  recorded that two scratch builds disagreed on exactly this question; it is settled here, on the
  real manifest.
- **`whoami` is unconditional in `tokio-postgres` and costs fourteen crates** — `wasm-bindgen` and
  companions, `js-sys`, `web-sys`, two `objc2-*`, `libredox`, `redox_syscall`, `r-efi`,
  `wit-bindgen`, `wasite`, `wasi 0.14`, `bumpalo`, `rustversion`. None compiles for this server.
  They are still real cost: recorded, cooldown-checked, audited, and each a name whose next
  release could matter. `tokio-postgres.md` has the detail.

## The two numbers, and which one the cap is about

| measurement | count | what it is |
|---|---|---|
| **In `Cargo.lock`** | **115** | every crate any target could resolve. What `gate-zero`, the cooldown and `cargo audit` all check |
| **Compiling for the server** | **91** | `cargo tree -p fathom-server --target x86_64-unknown-linux-gnu`. What actually links |
| **Running code at compile time, on Linux** | **7** | `getrandom`, `httparse`, `libc`, `parking_lot_core`, `proc-macro2`, `quote`, `serde_core` — every one a `build.rs` executing with the build host's full privileges, unsandboxed. `42` §6.2 predicted this row and stable Rust still has no answer to it |

Both are under `35` §5.1's ≤ 160, and 6 direct is well under ≤ 30.

## AN ESCALATION, NOT A PASS: the cap will not survive phase 1

WO-11 §7 trigger 3 says to escalate the number rather than trim by removing a security control.
**Escalating it now, while there is still time to decide.**

`49` §6 estimated the working server at *"roughly 109 crates"*. Four of its sixteen rows are in —
HTTP, runtime, driver, logging — and the lockfile is already at **115**. Still to come: sessions
(`tower-sessions`), password hashing (`argon2`, +22 from `00-CLOSURE.md`), passkeys
(`webauthn-rs`), TOTP (`totp-rs`), organisation sign-in (`openidconnect`, which brings an HTTP
client, JOSE and a JSON stack), mail (`lettre`), rate limiting (`governor`), the audit chain
(`blake3`) and `tower-http`.

**`openidconnect` alone is likely to be tens of crates**, and `argon2`'s closure is already
measured at 22. A straight-line reading says phase 1 lands well past 160.

Three routes, none chosen here because none is an execution session's to choose:

1. **Raise the cap**, with the reasoning written down — `35` §5.1's number predates the server
   and was set for a single offline HTML file.
2. **Drop a row.** `openidconnect` is the biggest and the most deferrable: organisation sign-in
   is not the first customer's blocker, and `70` §18 records enterprise LDAP/AD arriving as a
   phase-1 requirement, which is a different mechanism again.
3. **Split the cap** — one for what ships in the client, one for the server. They are different
   binaries with different threat models, and one number for both was never a decision anyone
   took.

The one thing the trigger forbids is meeting the number by removing a control.
