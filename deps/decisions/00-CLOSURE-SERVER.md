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
| `atomic-waker` | `1.1.2` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 14:59:32 GMT | https://github.com/smol-rs/atomic-waker |
| `axum` | `0.8.9` | MIT | DIRECT | no | no | Sun, 28 Jun 2026 18:07:52 GMT | https://github.com/tokio-rs/axum |
| `axum-core` | `0.5.6` | MIT | transitive | no | no | Sun, 28 Jun 2026 17:11:24 GMT | https://github.com/tokio-rs/axum |
| `bytes` | `1.12.1` | MIT | transitive | no | no | Wed, 08 Jul 2026 10:01:30 GMT | https://github.com/tokio-rs/bytes |
| `errno` | `0.3.14` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:08:03 GMT | https://github.com/lambda-fairy/rust-errno |
| `futures-channel` | `0.3.34` | MIT OR Apache-2.0 | transitive | no | no | Tue, 11 Aug 2026 12:13:11 GMT | https://github.com/rust-lang/futures-rs |
| `futures-core` | `0.3.34` | MIT OR Apache-2.0 | transitive | no | no | Tue, 11 Aug 2026 12:13:02 GMT | https://github.com/rust-lang/futures-rs |
| `futures-task` | `0.3.34` | MIT OR Apache-2.0 | transitive | no | no | Tue, 11 Aug 2026 12:13:08 GMT | https://github.com/rust-lang/futures-rs |
| `futures-util` | `0.3.34` | MIT OR Apache-2.0 | transitive | no | no | Tue, 11 Aug 2026 12:13:20 GMT | https://github.com/rust-lang/futures-rs |
| `http` | `1.5.0` | MIT OR Apache-2.0 | transitive | no | no | Wed, 29 Jul 2026 14:57:23 GMT | https://github.com/hyperium/http |
| `http-body` | `1.1.0` | MIT | transitive | no | no | Mon, 13 Jul 2026 17:25:07 GMT | https://github.com/hyperium/http-body |
| `http-body-util` | `0.1.5` | MIT | transitive | no | no | Wed, 12 Aug 2026 15:22:22 GMT | https://github.com/hyperium/http-body |
| `httparse` | `1.10.1` | MIT OR Apache-2.0 | transitive | yes | no | Sun, 28 Jun 2026 16:52:46 GMT | https://github.com/seanmonstar/httparse |
| `httpdate` | `1.0.3` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 15:19:36 GMT | https://github.com/pyfisch/httpdate |
| `hyper` | `1.11.1` | MIT | transitive | no | no | Fri, 28 Aug 2026 12:22:32 GMT | https://github.com/hyperium/hyper |
| `hyper-util` | `0.1.20` | MIT | transitive | no | no | Sun, 28 Jun 2026 16:55:10 GMT | https://github.com/hyperium/hyper-util |
| `itoa` | `1.0.18` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:55:52 GMT | https://github.com/dtolnay/itoa |
| `libc` | `0.2.189` | MIT OR Apache-2.0 | transitive | yes | no | Tue, 21 Jul 2026 21:33:29 GMT | https://github.com/rust-lang/libc |
| `matchit` | `0.8.4` | MIT AND BSD-3-Clause | transitive | no | no | Sun, 28 Jun 2026 14:48:04 GMT | https://github.com/ibraheemdev/matchit |
| `memchr` | `2.8.3` | Unlicense OR MIT | transitive | no | no | Wed, 08 Jul 2026 00:49:55 GMT | https://github.com/BurntSushi/memchr |
| `mime` | `0.3.17` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 15:18:11 GMT | https://github.com/hyperium/mime |
| `mio` | `1.2.2` | MIT | transitive | no | no | Mon, 13 Jul 2026 15:39:11 GMT | https://github.com/tokio-rs/mio |
| `percent-encoding` | `2.3.2` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 14:59:33 GMT | https://github.com/servo/rust-url/ |
| `pin-project-lite` | `0.2.17` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 14:40:19 GMT | https://github.com/taiki-e/pin-project-lite |
| `proc-macro2` | `1.0.107` | MIT OR Apache-2.0 | transitive | yes | no | Sun, 19 Jul 2026 00:18:26 GMT | https://github.com/dtolnay/proc-macro2 |
| `quote` | `1.0.47` | MIT OR Apache-2.0 | transitive | yes | no | Sun, 19 Jul 2026 00:16:58 GMT | https://github.com/dtolnay/quote |
| `serde_core` | `1.0.229` | MIT OR Apache-2.0 | transitive | yes | no | Sat, 18 Jul 2026 23:05:12 GMT | https://github.com/serde-rs/serde |
| `serde_derive` | `1.0.229` | MIT OR Apache-2.0 | transitive | no | yes | Sat, 18 Jul 2026 23:05:08 GMT | https://github.com/serde-rs/serde |
| `signal-hook-registry` | `1.4.8` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 16:11:53 GMT | https://github.com/vorner/signal-hook |
| `slab` | `0.4.12` | MIT | transitive | no | no | Sun, 28 Jun 2026 17:09:00 GMT | https://github.com/tokio-rs/slab |
| `smallvec` | `1.15.2` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 18:21:48 GMT | https://github.com/servo/rust-smallvec |
| `socket2` | `0.6.5` | MIT OR Apache-2.0 | transitive | no | no | Mon, 13 Jul 2026 19:45:59 GMT | https://github.com/rust-lang/socket2 |
| `syn` | `3.0.4` | MIT OR Apache-2.0 | transitive | no | no | Mon, 24 Aug 2026 00:39:55 GMT | https://github.com/dtolnay/syn |
| `sync_wrapper` | `1.0.2` | Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 16:27:08 GMT | https://github.com/Actyx/sync_wrapper |
| `tokio` | `1.53.1` | MIT | DIRECT | no | no | Mon, 20 Jul 2026 17:06:11 GMT | https://github.com/tokio-rs/tokio |
| `tokio-macros` | `2.7.2` | MIT | transitive | no | yes | Wed, 29 Jul 2026 13:15:28 GMT | https://github.com/tokio-rs/tokio |
| `tower` | `0.5.3` | MIT | transitive | no | no | Sun, 28 Jun 2026 16:05:58 GMT | https://github.com/tower-rs/tower |
| `tower-layer` | `0.3.3` | MIT | transitive | no | no | Sun, 28 Jun 2026 16:09:52 GMT | https://github.com/tower-rs/tower |
| `tower-service` | `0.3.3` | MIT | transitive | no | no | Sun, 28 Jun 2026 16:10:30 GMT | https://github.com/tower-rs/tower |
| `unicode-ident` | `1.0.24` | (MIT OR Apache-2.0) AND Unicode-3.0 | transitive | no | no | Sun, 28 Jun 2026 15:42:04 GMT | https://github.com/dtolnay/unicode-ident |
| `wasi` | `0.11.1+wasi-snapshot-preview1` | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 16:14:11 GMT | https://github.com/bytecodealliance/wasi |
| `windows-link` | `0.2.1` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:12:27 GMT | https://github.com/microsoft/windows-rs |
| `windows-sys` | `0.61.2` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:13:16 GMT | https://github.com/microsoft/windows-rs |

**43 external crates**, of which **2 direct**. **5 carry a `build.rs`** and **2 are proc-macros** — 7 of 43 run code at compile time, which is the number the August 2026 attack was about. Against `35` §5.1: **≤ 30 direct (2)**, **≤ 160 in the closure (43)**.

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
