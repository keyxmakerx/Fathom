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
| `errno` | `0.3.14` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:08:03 GMT | https://github.com/lambda-fairy/rust-errno |
| `libc` | `0.2.189` | MIT OR Apache-2.0 | transitive | yes | no | Tue, 21 Jul 2026 21:33:29 GMT | https://github.com/rust-lang/libc |
| `mio` | `1.2.2` | MIT | transitive | no | no | Mon, 13 Jul 2026 15:39:11 GMT | https://github.com/tokio-rs/mio |
| `pin-project-lite` | `0.2.17` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 14:40:19 GMT | https://github.com/taiki-e/pin-project-lite |
| `proc-macro2` | `1.0.107` | MIT OR Apache-2.0 | transitive | yes | no | Sun, 19 Jul 2026 00:18:26 GMT | https://github.com/dtolnay/proc-macro2 |
| `quote` | `1.0.47` | MIT OR Apache-2.0 | transitive | yes | no | Sun, 19 Jul 2026 00:16:58 GMT | https://github.com/dtolnay/quote |
| `signal-hook-registry` | `1.4.8` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 16:11:53 GMT | https://github.com/vorner/signal-hook |
| `socket2` | `0.6.5` | MIT OR Apache-2.0 | transitive | no | no | Mon, 13 Jul 2026 19:45:59 GMT | https://github.com/rust-lang/socket2 |
| `syn` | `3.0.4` | MIT OR Apache-2.0 | transitive | no | no | Mon, 24 Aug 2026 00:39:55 GMT | https://github.com/dtolnay/syn |
| `tokio` | `1.53.1` | MIT | DIRECT | no | no | Mon, 20 Jul 2026 17:06:11 GMT | https://github.com/tokio-rs/tokio |
| `tokio-macros` | `2.7.2` | MIT | transitive | no | yes | Wed, 29 Jul 2026 13:15:28 GMT | https://github.com/tokio-rs/tokio |
| `unicode-ident` | `1.0.24` | (MIT OR Apache-2.0) AND Unicode-3.0 | transitive | no | no | Sun, 28 Jun 2026 15:42:04 GMT | https://github.com/dtolnay/unicode-ident |
| `wasi` | `0.11.1+wasi-snapshot-preview1` | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 16:14:11 GMT | https://github.com/bytecodealliance/wasi |
| `windows-link` | `0.2.1` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:12:27 GMT | https://github.com/microsoft/windows-rs |
| `windows-sys` | `0.61.2` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:13:16 GMT | https://github.com/microsoft/windows-rs |

<!-- measured: 15 external crates, 1 direct, 3 with a build.rs, 1 proc-macros -->
**15 external crates**, of which **1 direct**. **3 carry a `build.rs`** and **1 are proc-macros** — 4 of 15 run code at compile time. Against `35` §5.1: ≤ 30 direct (1), ≤ 160 in the closure (15).
<!-- gate-zero:end -->

## What the gates said on arrival

Every one of these was run, not assumed:

- **`gate-zero` failed first**, naming all fifteen crates, and correctly separated `tokio` as a
  **DIRECT** dependency needing its own record from the fourteen transitive ones a closure may
  carry. That is the gate being exercised by a real arrival rather than a fixture.
- **`scripts/lockfile-lookalikes.sh` passed** across all 32 packages. Worth noting what is now in
  the graph: **`proc-macro2` itself**, the crate whose typosquat `proc-macro1` was the August 2026
  attack's vehicle. The look-alike check exists for precisely this shape, and it is now checking a
  lockfile that actually contains the target.
- **`scripts/crate-cooldown.sh` FAILED, on the first real dependency set, and it was right.**
  `mio 1.2.3` had been published **the previous day** — one day old against a seven-day window.
  Nothing suggests it is malicious; that is the point. A cooldown does not ask whether a release
  is bad, it declines to be the first to find out. The resolution was the one the script's own
  message names: pin back to **`mio 1.2.2`** (published 2026-07-13, 52 days old) with the reason
  written down. `mio 1.2.3`'s changelog is Wine support, a Unix-domain-socket re-registration fix
  under `poll(2)`, and a BSD waker change — nothing security-relevant and nothing touching the
  Linux `epoll` path this server runs on. Both RustSec advisories against `mio`
  (RUSTSEC-2020-0081, RUSTSEC-2024-0019) are patched at ≥ 0.7.6 and ≥ 0.8.11, far below 1.2.2.
  **Revisit the pin once 1.2.3 is a week old** — this is a hold, not a rejection.
- **`cargo deny` and `cargo audit`** both clean.
