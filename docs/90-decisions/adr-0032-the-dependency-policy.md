# ADR-0032 — Third-party code is permitted, gated at the build boundary, and vendored

> **Status:** Proposed — awaiting owner ratification
> **Date:** 2026-08-06
> **Register entry:** `88` §5.7 (the position no record owned); `78` §12 item 5
> **Reversal cost:** R2 while the count is zero; R4 once a dependency ships in a released artifact
> **Supersedes:** — (amends `35` §5 by making its caps enforceable; amends nothing in ADR-0019)

## Context

The workspace has **zero** external dependencies today — `Cargo.lock` holds six packages, all
first-party. That is the strongest single security fact in the repository, and `88` §5.7 found that
no decision record owns it: it lives in a comment in `Cargo.toml` and in `78` §5 item 2's rule that
adding one is *"an escalation, always"*. `78` §12 item 5 concedes the protocol's own citation for
the position was wrong — `35` §5.1 never said zero; it caps direct runtime dependencies at ≤ 30.

The gap is expensive. Specified deliverables in **five of the eight** queued work orders each need
a library and each defers the same question separately to "planning": the finder's on-disk index
(`fst`, zstd, blake3), property testing (`proptest`), fuzzing (`cargo-fuzz`, `arbitrary`), a hash
crate, and a browser test harness. None can decide it. The queue was quietly shipping weaker
versions of what the specification asked for, with nobody choosing that.

Asked, the owner answered (`70` §3, verbatim):

> *"as long as they are bundled and are not a security risk vector I'm for it. i suppose they don't
> have to be bundled but I'm just concerned the implications here. my recommendations is look at
> what other enterprise solutions use here, and how might AI miss things and preemptively try to
> shore up those concerns."*

Both research instructions are discharged below: §2 surveys current practice, §4 is the adversarial
pass. The owner also said they did not know what the candidate libraries were, so §1 states that
first.

## Decision

### 1. What is actually being permitted

Three tiers, and the security question lives almost entirely in the split between them.

| Tier | Count | Ships to the user? | Examples, and what they do |
|---|---|---|---|
| **Runtime** | 20 proposed (`41` §7.1) | **Yes — inside the artifact** | 13 are cryptography (`chacha20poly1305`, `argon2`, `hkdf`, `sha2`, `subtle`, the curve25519 family, `minisign-verify`, `getrandom`, `blake3`) — the machinery that makes a stolen workspace file unreadable. 3 are search speed (`fst`, `memchr`, a pure-Rust zstd). 4 are plumbing (`unicode-normalization`, `thiserror`, `wasm-bindgen`) |
| **Build-time** | ~11 (`42` §3.1) | No — build machine only | The toolchain and assembly tools. `42` already marks which four can alter the shipped bytes |
| **Test-only** | ~10 | **No — never ship** | `proptest`, `cargo-fuzz`, `arbitrary`, a browser driver |

Two thirds of the runtime tier is cryptography, and `32` §15 is titled *"What is deliberately not
rolled by hand"*. Writing that code in-house is the genuinely dangerous option; `subtle`'s own row
in `41` says *"Do not hand-roll; the compiler is the adversary here."* The elective part of the
runtime ask is small.

### 2. The four layers, adopted in full

Current enterprise practice (§Sources) has converged on four cumulative layers. Mozilla runs all
four simultaneously; the framing of "vendor **or** pin" is a false dichotomy in current practice.
Fathom adopts all four:

| Layer | Tool | What it does | What it does **not** do |
|---|---|---|---|
| 1 | `Cargo.lock` + `--locked` on **every** cargo invocation | Pins the exact code | Nothing about whether that code is safe |
| 2 | `cargo-deny` (advisories, bans, licences, sources) and `cargo-audit` | Enforces policy; reports **disclosed** vulnerabilities | Detects nothing malicious. Neither is evidence a crate is not hostile |
| 3 | `cargo-vet` | Records that a **named human read the code**. The only layer that addresses deliberate malice | Analyses nothing. It is an attestation ledger |
| 4 | `cargo vendor`, committed to the repository | Makes the build hermetic and the reproducibility claim checkable **without network access** | Verifies nothing — it copies source |

**This settles the owner's bundling instinct: vendored source is committed to the tree**, as
Firefox and Chromium both do. It is what makes `35` §1.1's reproducibility claim checkable by a
stranger, which matters more here than for most projects because the whole security argument is
*"you can verify this yourself"*.

`cargo-vet`'s two built-in criteria map exactly onto Fathom's threat model, which is why it is the
right ledger: **`safe-to-run`** covers code executing on the build machine, **`safe-to-deploy`**
covers code in the shipped artifact.

### 3. `35` §5.1's caps become enforceable, and one is added

`35` §5.1 already sets eight caps and claims *"All are enforced in CI."* They are not enforced
anywhere. This ADR does not invent numbers — it adopts `35`'s and makes them real:

C1 ≤ 30 direct runtime · C2 ≤ 160 closure · **C3 ≤ 25 distinct publishing identities** ·
C4 ≤ 12 crates with a `build.rs` · C5 ≤ 10 proc-macro crates · C6 = 0 npm · C7 no C/C++ ·
C8 one implementation per job.

C3 is the one that converts the owner's *"not a security risk vector"* into an enforceable number,
and `35` says so: *"EVERY DEPENDENCY IS A PUBLISHER YOU HAVE GIVEN CODE-EXECUTION RIGHTS ON EVERY
USER'S MACHINE. COUNT THE PUBLISHERS, NOT THE CRATES."*

**Added — C9: the shipped closure prefers crates with no `unsafe` code.** Google's published
auditing standard grades crates on a five-point unsafe-risk scale; its top tier, `ub-risk-0`, is
*"no unsafe code"*. `35` §5.1's C7 already bans C and C++ in the closure; C9 extends the same
reasoning one step and is mechanically checkable. A crate that needs `unsafe` is admissible with a
recorded reason, exactly as C7 admits none.

### 4. What an automated session would miss — the controls that answer each

This section discharges the owner's second instruction. Each row is a real route in **this**
codebase, with the control that closes it.

| # | The route in | Control |
|---|---|---|
| 1 | **CI does not look at dependencies at all.** All four gates pass green with two hundred new crates. Every control `35` specifies — `deny.toml`, `deps/decisions/`, `supply-chain/`, `build/toolchain.lock` — is written down and **the files do not exist** | **Gate zero, and it is the cheapest control that will ever be available**: a CI step that fails if `Cargo.lock` gains any non-first-party package without an approval record beside it. Because the answer today is exactly zero, this is three lines now and expensive later |
| 2 | **`--locked` is defeated by the step before it.** `clippy` runs without `--locked` and re-resolves, writing a fresh lockfile; `cargo test --locked` then reads the file clippy just wrote and finds it consistent. The crate's `build.rs` has already executed on the runner before any gate produced a result | `--locked` on **every** cargo invocation in `ci.yml`, and a `cargo metadata --locked --offline` step first |
| 3 | **`build.rs` and proc macros run arbitrary code on the build machine with its full privileges**, before any test. `35` §5.7 states this precisely and rates the residual `material`. Zero exist today. CI runs on a stock runner with full network | C4 and C5 enforced; `deps/build-scripts.md` per `35` §5.7; and the hermetic build container `35` already specifies and nobody has built |
| 4 | **The concrete path from "we need randomness" to "the module can make a network request."** `41` §3.7 routes `getrandom` through a **custom backend** to the raw ABI precisely so that `js-sys` leaves the closure — because `js-sys`'s sibling `web-sys` is what exposes `fetch`, `WebSocket` and `XMLHttpRequest` to Rust. `41`'s own `VERIFY` note says that if the mechanism has changed, the fallback is `wasm_js` **plus a three-entry import allowlist** — i.e. the documented fallback re-admits the dependency the design removed. `32` and `41` also disagree on the `getrandom` version | Land WO-07's import audit **before any crypto work starts**, and reconcile the version between `32` and `41` first. This is the single most likely way an automated session breaks invariant 1 *while following the documents* |
| 5 | **The import allowlist does not catch `std::net`.** On `wasm32-unknown-unknown`, `std::net` compiles to stubs that return errors rather than to host imports — so a crate pulling in `TcpStream` adds no import and trips no gate. It sits dormant, and comes alive on any native or WASI build | `03` §3.5's **T-P1-a** — a denylist of network-capable crates checked against the **resolved** graph, not the manifest. `38` §2.4 already audits this as **"Not met"** and calls it out: *"The strength of invariant 2 today rests on the fact that nobody has written any code at all. That is not the same thing as a gate."* |
| 6 | **One dependency erases determinism silently.** `fathom-corpus/src/detln.rs` hand-rolls natural logarithm because `f64::ln` routes to libm and is not bit-identical across targets. Any layout or maths crate reintroduces libm; any crate using `HashMap` reintroduces iteration-order nondeterminism. The whole of `crates/` currently contains **zero** `HashMap`/`HashSet` | A determinism criterion in the per-crate audit record, and the existing cross-target golden tests extended to any crate entering the closure |
| 7 | **Licence contamination** against ADR-0004's Apache-2.0 / CC BY-SA split | `cargo-deny`'s licence check, with the allowlist derived from ADR-0004 |
| 8 | **The actual likely vector is not a careless session.** `78` §5 item 2 already forbids an execution session adding a dependency. The realistic route is a **planning session writing a crate name into a work order as a verbatim block**, which the next session then types in faithfully and correctly, with no human in between | Per-crate approval (item 5) is an **owner** act, never a planning one. A crate name in a work order without a matching approval record makes that order malformed under `78` §8 |

### 5. The process for admitting one

`35` §5.3's process, made concrete and owner-gated:

1. A planning session writes `deps/decisions/<crate>.md`: what job, why not first-party, the
   publisher, the licence, whether it ships or is build/test-only, `build.rs` and proc-macro
   status, `unsafe` status against C9, and the determinism assessment.
2. **The owner approves it.** One line, recorded in the file. This is the gate that item 4 row 8
   requires and it may not be delegated to a planning session.
3. Only then may a work order name the crate, and it must cite the approval record.
4. The crate is vendored, `cargo-vet` records an audit (imported from Mozilla, Google, the Bytecode
   Alliance or ISRG where one exists; written first-party where none does), and `cargo-deny`'s
   policy is updated.

**Expect to be a net producer of audits, not a consumer.** `cargo-vet`'s shared registry has nine
organisations in it; a 25-publisher closure will not be covered by imports. That is a defensible
position to state publicly and is itself consistent with the estate-of-record claim.

### 6. Sequencing — gate zero comes first

**No dependency is admitted until item 4 row 1's gate and item 2's `--locked` fix are in CI.**
This is the whole substance of the owner's *"preemptively try to shore up those concerns"*: the
controls land before the thing they control, not after. Both are small, and both are `78` §5 item 7
territory (`.github/workflows/`), so they are owner or planning work, never an execution session's.

## Consequences

### Positive

- Five queued work orders stop deferring the same question. `88` §5.7 is discharged.
- `35` stops being aspirational. A reviewer who reads `35` and then reads `ci.yml` currently finds
  the gap in under a minute, and it is the kind of gap that costs the whole security argument
  rather than one point of it.
- The specification gets what it asked for: a real on-disk finder index, property tests, fuzzing of
  the config parser — the last of which is a security control in its own right, since the parser is
  the only untrusted input path in the product.
- Vendored source makes the reproducibility claim checkable offline, which is a stronger position
  than most projects can hold and directly serves the never-connects argument.

### Negative

- **The strongest security fact in the repository is spent.** "Zero third-party code" is a sentence
  no competitor can say. Whatever replaces it is a longer and less convincing sentence, and this
  ADR should not pretend otherwise.
- Four new tools in the build path, each of which is itself software that can fail or be
  compromised. `cargo-vet` and `cargo-deny` are build-time only, which bounds it, but does not
  remove it.
- Vendoring commits a large amount of code the project did not write into the repository, which
  makes the tree bigger, slower to clone, and noisier to review.
- The per-crate approval gate puts real work on the owner — the one resource `72` names as
  scarcest. Twenty runtime crates is twenty approvals before the crypto work can start.
- `cargo-vet` audits are per **version**. Every upgrade re-opens the question, forever.

## Alternatives considered

| Option | Why not |
|---|---|
| **Stay at zero** | Defensible, and it was the status quo. Rejected by the owner's answer. It also has a cost the corpus already priced: no fuzzing of the parser, a hand-rolled index, and hand-rolled cryptography — which `32` §15 identifies as the genuinely dangerous option |
| **Lockfile pinning only, no vendoring** | The owner's instinct said bundle, and current practice agrees: Mozilla and Chromium vendor **on top of** pinning. Pinning alone leaves the build dependent on a network fetch, which contradicts the offline posture |
| **`cargo-crev` instead of `cargo-vet`** | Philosophically closer — a web of trust rather than a small set of named organisations — but it has no enterprise adoption and no organisational audit registry to import from. Named here because a reviewer who knows the ecosystem will ask, and *"we looked and it has no institutional counterparties"* is a better answer than silence |
| **Allow test-only dependencies now, runtime later** | Tempting and genuinely lower-risk, since test crates never ship. Rejected because `build.rs` risk is identical for a test-only crate — it executes on the build machine either way — so it would buy less safety than it appears to while still requiring every control in item 4 |

## Revisit if

- Any cap in item 3 is reached, in particular C3 (25 publishers) or C9's no-`unsafe` preference.
- A crate in the shipped closure is found to have an undisclosed vulnerability, or a publisher in
  the closure is compromised. Either event should trigger a re-read of item 2's layer table, not
  just a version bump.
- `cargo-vet`'s import registry loses one of the four organisations Fathom relies on.
- The owner withdraws the per-crate approval gate as too costly — in which case the honest
  replacement is a smaller cap, not a delegated approval.
- A hermetic build container is built, which would materially lower row 3's residual and should be
  recorded as doing so.

## Sources consulted

Current practice was surveyed on 2026-08-06 and each claim re-checked against a primary source.

| Source | Taken |
|---|---|
| `mozilla.github.io/cargo-vet/` and `/built-in-criteria.html` | `safe-to-run` and `safe-to-deploy`, quoted; the audit-sharing model |
| `github.com/mozilla/cargo-vet/blob/main/registry.toml` | The nine importable organisations, including the Bytecode Alliance and Google |
| `raw.githubusercontent.com/google/rust-crate-audits/main/auditing_standards.md` | The five-point `ub-risk` scale; `crypto-safe`; the reviewer-expertise requirements behind C9 |
| `firefox-source-docs.mozilla.org/build/buildsystem/rust.html` | Vendoring into `third_party/rust`; `mach vendor rust` running `cargo vet`; the four layers run together |
| `embarkstudios.github.io/cargo-deny/` and `/checks/bans/` | The four checks; the stated limits of duplicate detection |
| `rustsec.org` and the advisory-db README | `cargo-audit`'s scope: disclosed vulnerabilities only |
| `doc.rust-lang.org` — `cargo vendor` | Vendored sources are read-only; nothing is verified |
| `github.com/crev-dev/cargo-crev` | The alternative considered and its adoption status |
| `docs/30-security/35-supply-chain-and-builds.md` §§5.1–5.7, §1.1, §11.3 | The eight caps, verbatim; the process; §5.7's honest gap and its `material` residual |
| `docs/00-vision/03-non-goals-and-scope.md` §3.5; `docs/30-security/38-the-egress-question.md` §2.4, §11 | T-P1-a and its **Not met** scorecard row, quoted |
| `docs/40-stack/41-technology-choices.md` §3.7, §7.1; `docs/30-security/32-cryptography.md` §15.1 | The 20-crate runtime list; the raw ABI and the `getrandom` custom backend; the version disagreement |
| `docs/40-stack/42-no-node-runtime.md` §3.1, §9.4 | The build-time tool list and which four alter shipped bytes |
| `Cargo.toml`, `Cargo.lock`, `.github/workflows/ci.yml`, `crates/fathom-corpus/src/detln.rs` | Zero dependencies; the four gates; the determinism worked example |

## Disagreements

1. **Against `35` §5.1's claim that its caps are enforced.** The sentence *"Six numbers. All are
   enforced in CI"* is false today and has been since it was written — `ci.yml` runs four commands,
   none of which reads a dependency graph. This ADR adopts the numbers and supplies the enforcement;
   `35`'s sentence should be corrected to a forward reference in the same pass. Note also that §5.1
   says *"Six numbers"* and lists eight constraints (C1–C8); the count is wrong independently of
   the enforcement claim.

2. **On item 4 row 5's mechanism.** That `std::net` compiles to error-returning stubs on
   `wasm32-unknown-unknown` rather than to host imports is well-established Rust behaviour but was
   not demonstrated in this tree, because doing so requires a build. It is marked *likely* rather
   than *proved*, and T-P1-a is the right control whether or not the mechanism is exactly as stated
   — the check reads the resolved dependency graph, so it does not depend on the compilation detail.

3. **Against the framing that vendoring is a security control.** It is not, and §2's table says so.
   It is a durability and hermeticity control. Vendoring a hostile crate vendors the hostility. The
   security is layer 3, and layer 3 is a human reading code — which is the honest and unglamorous
   answer to the owner's question.
